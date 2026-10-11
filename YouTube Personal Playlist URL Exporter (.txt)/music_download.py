#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""วางไฟล์นี้ข้างรายการ URL .txt แล้วดับเบิลคลิก หรือ python music_download.py
ใช้ yt-dlp ที่อยู่ใน PATH เหมือนคำสั่ง yt-dlp ที่พิมพ์เอง แสดงที่อยู่ก่อนเริ่ม
ดาวน์โหลดด้วย -f "ba[ext=m4a]/ba[acodec^=mp4a]/ba" -x --audio-format mp3
--audio-quality 320K -a รายการที่คัดแล้ว เพิ่มเพียงโฟลเดอร์ปลายทางและประวัติโหลดสำเร็จ
ค่าพื้นฐาน: ตรวจชื่อ 4 งาน / ดาวน์โหลด 1 งาน เลือกดาวน์โหลดหลายงานได้เอง
ไม่อัปเดต/ติดตั้งเครื่องมือ ไม่เพิ่ม cookies และไม่ปิด config เดิม
ตรวจชื่อผ่าน oEmbed และใช้ cache เดิม; ไม่เรียก yt-dlp เต็มเพื่ออ่านชื่อ
คัดแยกแต่ละไฟล์: Lyrics > Audio > ชื่อทั่วไป > MV; MV เดี่ยวเก็บไว้
ชื่อที่ไม่แน่ใจเก็บไว้ใน review.csv; URL ที่ตรวจชื่อไม่ได้อยู่ใน unresolved.txt
รายงาน: _music_reports/ชื่อไฟล์/ | เพลง: โฟลเดอร์ชื่อเดียวกับไฟล์ .txt
ไฟล์ต้นฉบับไม่ถูกแก้ไข ใช้ overrides.json (keep/drop เป็น URL) ปรับผลคัดเองได้
คำสั่ง: --scan / --download --workers 3 / --refresh / --yt-dlp "C:\\path\\yt-dlp.exe"
หากคำสั่ง yt-dlp ในเครื่องเป็น alias ให้ระบุ executable ด้วย --yt-dlp
"""
import argparse
import csv
import difflib
import json
import os
import re
import subprocess
import sys
import threading
import unicodedata
from collections import deque
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parent
STATE = ROOT / '_music_reports'
FORMAT = 'ba[ext=m4a]/ba[acodec^=mp4a]/ba'
TAGS = re.compile(r'\b(?:official\s+)?(?:music\s+video|lyric(?:s)?(?:\s+video)?|audio(?:\s+video)?|visuali[sz]er|mv|m/v)\b|เนื้อเพลง|มิวสิควีดีโอ|มิวสิควิดีโอ|มิวสิกวิดีโอ|オフィシャルビデオ|歌詞|가사|뮤직비디오|歌词', re.I)
VERSIONS = re.compile(r'\b(?:live|cover|remix|acoustic|instrumental|karaoke|sped\s*up|slowed|nightcore|remaster(?:ed)?)\b|แสดงสด|คัฟเวอร์|คาราโอเกะ|คอนเสิร์ต', re.I)
BLOCK = re.compile(r'HTTP (?:Error )?429|too many requests|confirm you.re not a bot|temporarily blocked|rate.?limit', re.I)

def save_json(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)

def norm(text):
    text = unicodedata.normalize('NFKC', text).casefold()
    return ''.join(c for c in text if unicodedata.category(c)[0] in 'LNM')

def clean(title):
    title = TAGS.sub(' ', unicodedata.normalize('NFKC', title))
    title = re.sub(r'\b(?:official|hd|4k|1080p|720p)\b', ' ', title, flags=re.I)
    title = re.sub(r'[\[\](){}【】「」]', ' ', title)
    return re.sub(r'\s+', ' ', title).strip(' -|:')

def priority(title):
    if re.search(r'lyric|เนื้อเพลง|歌詞|歌词|가사', title, re.I): return 0
    if re.search(r'\baudio\b', title, re.I): return 1
    if re.search(r'\bmv\b|m/v|music\s+video|มิวสิ|뮤직비디오', title, re.I): return 3
    return 2

def video_key(url):
    p = urlparse(url)
    host = (p.hostname or '').lower()
    vid = None
    if host in ('youtu.be', 'www.youtu.be'): vid = p.path.strip('/').split('/')[0]
    elif host in ('youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'):
        vid = parse_qs(p.query).get('v', [None])[0]
        if not vid and p.path.startswith(('/shorts/','/embed/')):
            vid = p.path.split('/')[2]
    return 'youtube:'+vid if vid else url

def song_key(info):
    title = info['title']
    versions = tuple(sorted({norm(m.group()) for m in VERSIONS.finditer(title)}))
    parts = re.split(r'\s*[-–—|:：]\s*', clean(title))
    # Two explicit parts are treated as song/artist; bare names are review-only.
    if len(parts) == 2 and all(norm(p) for p in parts):
        return ('title', tuple(sorted(norm(p) for p in parts)), versions)
    artist = info.get('artist') or ' '.join(info.get('artists') or [])
    if info.get('track') and artist:
        return ('metadata', norm(info['track']), norm(artist), versions)
    return None

def analyze(rows, overrides):
    seen, kept, removed = {}, [], []
    for row in rows:
        key = video_key(row['url'])
        if row['url'] in overrides.get('drop', []):
            removed.append((row, None, 'กำหนดตัดเอง'))
        elif key in seen:
            removed.append((row, seen[key], 'วิดีโอ ID เดียวกัน'))
        else:
            seen[key] = row
            kept.append(row)
    groups = {}
    for row in kept:
        key = song_key(row['info']) if row.get('info') else None
        if key and row['url'] not in overrides.get('keep', []):
            groups.setdefault(key, []).append(row)
    dropped = set()
    for group in groups.values():
        winner = min(group, key=lambda r:(priority(r['info']['title']), r['line']))
        for row in group:
            if row is not winner:
                dropped.add(row['line'])
                removed.append((row, winner, 'ชื่อเพลง/ศิลปินตรงกันหลังตัดแท็ก; Lyrics > Audio > ทั่วไป > MV'))
    kept = [r for r in kept if r['line'] not in dropped]
    review = []
    for i, a in enumerate(kept):
        if not a.get('info'): continue
        x = norm(clean(a['info']['title']))
        for b in kept[i+1:]:
            if not b.get('info'): continue
            y = norm(clean(b['info']['title']))
            ratio = difflib.SequenceMatcher(None, x, y).ratio()
            if x and y and (ratio >= .78 or (min(len(x),len(y)) >= 8 and (x in y or y in x))):
                review.append((a,b,round(ratio,3)))
    return kept, removed, review

def csv_file(path, header, rows):
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f); writer.writerow(header); writer.writerows(rows)

def title(row):
    return row.get('info',{}).get('title','(ยังตรวจชื่อไม่ได้)') if row else ''

def report(folder, rows, kept, removed, review):
    csv_file(folder/'removed.csv', ['บรรทัด','ชื่อที่ตัด','URL ที่ตัด','ชื่อที่เก็บ','URL ที่เก็บ','เหตุผล'],
             ([a['line'],title(a),a['url'],title(b),b['url'] if b else '',why] for a,b,why in removed))
    csv_file(folder/'review.csv', ['ชื่อ A','URL A','ชื่อ B','URL B','ความคล้าย (ไม่ใช่ความมั่นใจ)'],
             ([title(a),a['url'],title(b),b['url'],score] for a,b,score in review))
    csv_file(folder/'metadata_errors.csv', ['บรรทัด','URL','ข้อผิดพลาด'],
             ([r['line'],r['url'],r.get('error','')] for r in rows if not r.get('info')))
    ready = [r for r in kept if r.get('info')]
    unknown = [r for r in kept if not r.get('info')]
    for name, items in [('kept.txt',kept),('ready.txt',ready),('unresolved.txt',unknown)]:
        (folder/name).write_text(''.join(r['url']+'\n' for r in items), encoding='utf-8')
    text = f'ทั้งหมด {len(rows)} | เก็บ {len(kept)} | คัดออก {len(removed)}\nคู่ที่ควรตรวจ {len(review)} | ยังตรวจชื่อไม่ได้ {len(unknown)} | พร้อมดาวน์โหลด {len(ready)}\n'
    (folder/'summary.txt').write_text(text, encoding='utf-8'); print(text)
    return ready

def fetch_title(item):
    key, url = item
    if not key.startswith('youtube:'):
        return key, None, 'รองรับการตรวจชื่อเฉพาะ URL วิดีโอ YouTube', False
    endpoint = 'https://www.youtube.com/oembed?' + urlencode({'url':'https://www.youtube.com/watch?v='+key.split(':',1)[1], 'format':'json'})
    try:
        with urlopen(endpoint, timeout=20) as response: data = json.load(response)
        if not data.get('title'): raise ValueError('ไม่มีชื่อในผลตอบกลับ')
        return key, {'title':data['title'],'source':'oembed'}, '', False
    except HTTPError as e:
        return key, None, str(e), e.code == 429
    except (URLError, OSError, ValueError) as e:
        return key, None, str(e), False

def scan(rows, cache, cache_path, workers, refresh):
    missing = {video_key(r['url']):r['url'] for r in rows if refresh or not cache.get(video_key(r['url']),{}).get('title')}
    print(f'ตรวจชื่อใหม่ {len(missing)} URL (ใช้ cache สำหรับชื่อที่มีแล้ว)')
    queue, errors, stopped = deque(missing.items()), {}, False
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {}
        count = 0
        while jobs or (queue and not stopped):
            while queue and len(jobs)<workers and not stopped:
                item = queue.popleft(); jobs[pool.submit(fetch_title,item)] = item
            done,_ = wait(jobs, return_when=FIRST_COMPLETED)
            for future in done:
                jobs.pop(future)
                key, info, error, blocked = future.result(); count += 1
                if info:
                    cache[key] = info; save_json(cache_path,cache)
                else: errors[key] = error
                stopped = stopped or blocked
                print(f'ชื่อ {count}/{len(missing)}: {info["title"] if info else error}', flush=True)
    for key,url in queue: errors[key] = 'ยังไม่ได้ตรวจ: หยุดส่งคำขอหลังพบ HTTP 429'
    for row in rows:
        key = video_key(row['url'])
        if key in errors: row['error'] = errors[key]
        elif cache.get(key): row['info'] = cache[key]
    return stopped

def executable(explicit=None):
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if path.is_file(): return str(path)
        raise RuntimeError(f'ไม่พบ yt-dlp ที่ระบุ: {path}')
    # Search only PATH, in its normal order; never prefer a neighboring binary.
    extensions = os.environ.get('PATHEXT','.COM;.EXE;.BAT;.CMD').split(';') if os.name=='nt' else ['']
    for directory in os.environ.get('PATH','').split(os.pathsep):
        if not directory: continue
        for extension in extensions:
            path = Path(directory.strip('"'))/('yt-dlp'+extension.lower())
            if path.is_file() and (os.name=='nt' or os.access(path,os.X_OK)):
                return str(path.resolve())
    raise RuntimeError('ไม่พบ yt-dlp ใน PATH ของ Python นี้ เปิด Terminal ที่ใช้คำสั่งเดิมได้ แล้วรัน python music_download.py หรือระบุตำแหน่งด้วย --yt-dlp')

def download_command(exe, batch, output, archive):
    return [exe,'-f',FORMAT,'-x','--audio-format','mp3','--audio-quality','320K',
            '-a',str(batch),'-P',str(output),'--download-archive',str(archive)]

def download(exe, rows, output, folder, workers):
    if not rows: return
    output.mkdir(exist_ok=True)
    jobs_dir = folder/'batches'; jobs_dir.mkdir(exist_ok=True)
    archive = output/'downloaded.archive'
    done = set(archive.read_text(encoding='utf-8').splitlines()) if archive.exists() else set()
    # Recover successful downloads from interrupted current or older versions.
    for base in (jobs_dir, folder/'download_jobs'):
        if base.exists():
            for f in base.glob('*.archive'): done.update(f.read_text(encoding='utf-8').splitlines())
    rows = [r for r in rows if video_key(r['url']).replace('youtube:','youtube ',1) not in done]
    archive.write_text(''.join(x+'\n' for x in sorted(done)), encoding='utf-8')
    if not rows:
        print('ดาวน์โหลดสำเร็จไว้แล้วทั้งหมด'); return
    count = min(workers,len(rows))
    stop = threading.Event(); lock = threading.Lock(); processes = set()
    def run_batch(index):
        batch = jobs_dir/f'{index+1}.txt'; history = jobs_dir/f'{index+1}.archive'
        batch.write_text(''.join(r['url']+'\n' for r in rows[index::count]), encoding='utf-8')
        history.write_text(''.join(x+'\n' for x in sorted(done)), encoding='utf-8')
        cmd = download_command(exe,batch,output,history)
        with lock:
            if stop.is_set(): return {'batch':index+1,'status':'not_started'}
            print('คำสั่ง:',subprocess.list2cmdline(cmd),flush=True)
            process = subprocess.Popen(cmd,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,errors='replace',bufsize=1)
            processes.add(process)
        try:
            with (jobs_dir/f'{index+1}.log').open('w',encoding='utf-8') as log:
                for line in process.stdout:
                    log.write(line); log.flush()
                    with lock:
                        print((f'[{index+1}] ' if count>1 else '')+line.rstrip(),flush=True)
                        if BLOCK.search(line) and ('ERROR' in line or 'WARNING' in line):
                            stop.set()
                            for active in list(processes):
                                if active.poll() is None: active.terminate()
            return {'batch':index+1,'exit_code':process.wait()}
        finally:
            process.stdout.close()
            with lock: processes.discard(process)
    print(f'ดาวน์โหลด {len(rows)} เพลง ด้วย yt-dlp {count} งาน แต่ละงานใช้ -a ตามคำสั่งเดิม')
    pool = ThreadPoolExecutor(max_workers=count)
    try:
        futures = [pool.submit(run_batch,i) for i in range(count)]
        results = [future.result() for future in futures]
        save_json(folder/'download_status.json',results)
    finally:
        stop.set()
        with lock:
            for process in list(processes):
                if process.poll() is None: process.terminate()
        pool.shutdown(wait=True)
        for f in jobs_dir.glob('*.archive'): done.update(f.read_text(encoding='utf-8').splitlines())
        temporary = archive.with_suffix('.tmp')
        temporary.write_text(''.join(x+'\n' for x in sorted(done)),encoding='utf-8'); temporary.replace(archive)
    if any(r.get('exit_code',1) for r in results):
        raise RuntimeError('yt-dlp จบด้วยข้อผิดพลาด ดูข้อความจริงด้านบน เพลงที่สำเร็จบันทึกไว้แล้ว')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--scan',action='store_true'); modes.add_argument('--download',action='store_true')
    parser.add_argument('--workers',type=int,default=1)
    parser.add_argument('--scan-workers',type=int,default=4)
    parser.add_argument('--refresh',action='store_true'); parser.add_argument('--yt-dlp')
    args = parser.parse_args()
    if not 1<=args.workers<=16 or not 1<=args.scan_workers<=16: parser.error('จำนวนงานต้องอยู่ระหว่าง 1–16')
    if not args.scan and not args.download:
        print('=== ดาวน์โหลดเพลงและคัดซ้ำ — ใช้คำสั่งเดิม ===\n1. ตรวจและทำรายงาน\n2. ตรวจแล้วดาวน์โหลด\n3. วิธีใช้\n0. ออก')
        while True:
            choice = input('เลือก: ').strip()
            if choice=='0': return
            if choice=='3': print(__doc__); continue
            if choice not in ('1','2'): continue
            args.scan = choice=='1'
            if not args.scan:
                while True:
                    count = input('ดาวน์โหลดพร้อมกันกี่งาน [Enter = 1 แบบคำสั่งเดิม]: ').strip() or '1'
                    if count.isdigit() and 1<=int(count)<=16:
                        args.workers=int(count); break
            break
    exe = executable(args.yt_dlp) if not args.scan else None
    if exe:
        print('ใช้ yt-dlp:',exe)
        subprocess.run([exe,'--version'],cwd=ROOT,check=True)
    files = sorted(ROOT.glob('*.txt'))
    if not files: raise RuntimeError('ไม่พบไฟล์ .txt ข้างสคริปต์')
    STATE.mkdir(exist_ok=True)
    cache_path=STATE/'metadata_cache.json'
    cache=json.loads(cache_path.read_text(encoding='utf-8-sig')) if cache_path.exists() else {}
    for source in files:
        rows=[]
        for n,line in enumerate(source.read_text(encoding='utf-8-sig').splitlines(),1):
            url=line.strip()
            if not url or url.startswith('#'): continue
            p=urlparse(url)
            if p.scheme not in ('http','https') or not p.netloc:
                raise RuntimeError(f'{source.name} บรรทัด {n} ไม่ใช่ URL')
            rows.append({'line':n,'url':url})
        print('\n=== '+source.name+' ===')
        folder=STATE/source.stem;folder.mkdir(exist_ok=True)
        override_path=folder/'overrides.json'
        if not override_path.exists(): save_json(override_path,{'keep':[],'drop':[]})
        overrides=json.loads(override_path.read_text(encoding='utf-8-sig'))
        if set(overrides.get('keep',[])) & set(overrides.get('drop',[])):
            raise RuntimeError('URL เดียวกันอยู่ทั้ง keep/drop ใน '+str(override_path))
        blocked=scan(rows,cache,cache_path,args.scan_workers,args.refresh)
        kept,removed,review=analyze(rows,overrides)
        ready=report(folder,rows,kept,removed,review)
        if blocked: raise RuntimeError('ตรวจชื่อพบ HTTP 429 หยุดรอบนี้และบันทึก cache แล้ว')
        if not args.scan: download(exe,ready,ROOT/source.stem,folder,args.workers)
    print('เสร็จแล้ว รายงาน:',STATE)

if __name__=='__main__':
    code=0
    try: main()
    except KeyboardInterrupt: print('\nหยุดแล้ว');code=130
    except Exception as error: print('ERROR:',error);code=1
    if len(sys.argv)==1:
        try: input('\nกด Enter เพื่อปิด...')
        except (EOFError,KeyboardInterrupt): pass
    sys.exit(code)
