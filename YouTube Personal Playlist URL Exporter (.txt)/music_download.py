#!/usr/bin/env python3
"""วิธีใช้: วางไฟล์นี้ข้างไฟล์ .txt รายการ URL แล้วดับเบิลคลิก
ต้องมี Python, yt-dlp และ FFmpeg (ffmpeg + ffprobe)
ติดตั้ง yt-dlp: python -m pip install -U "yt-dlp[default]"
วาง yt-dlp.exe, ffmpeg.exe, ffprobe.exe ข้างสคริปต์ได้ ถ้ามีอยู่แล้ว
รายงาน: _music_reports/ชื่อไฟล์/ ; เพลง: โฟลเดอร์ชื่อเดียวกับไฟล์ .txt
ไม่แก้ไฟล์ต้นฉบับ คัดแยกในแต่ละหมวด เลือก Lyrics เหนือ MV เมื่อชื่อจับคู่ได้
ชื่อคล้ายที่ไม่แน่ใจเก็บทั้งคู่และแจ้ง review.csv โปรดตรวจ removed.csv ครั้งแรก
ตรวจชื่อผ่าน YouTube oEmbed ก่อน ไม่ต้องดึงข้อมูลสตรีมเต็มทุกเพลง
ตรวจชื่อและดาวน์โหลดหลายงานพร้อมกัน ปรับตาม CPU/RAM และขีดจำกัดบริการ
รายการที่ยังดึงชื่อไม่ได้เก็บในรายงาน แต่พักดาวน์โหลดจนตรวจซ้ำได้
รันคำสั่ง: python music_download.py --scan / --download / --refresh
กำหนดเพดานเอง: --workers 16 --scan-workers 32 (ยังจำกัดตามทรัพยากรที่ตรวจพบ)
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import os
import time
import csv
import difflib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from collections import deque

ROOT = Path(__file__).resolve().parent
STATE = ROOT / '_music_reports'
# Extra yt-dlp options, e.g. ['--cookies-from-browser', 'brave']
EXTRA_YTDLP_ARGS = []
DEFAULT_DOWNLOAD_WORKERS = 0  # 0 = ปรับอัตโนมัติตามทรัพยากร

def available_memory_gb():
    try:
        if sys.platform == 'win32':
            import ctypes
            class MemoryStatus(ctypes.Structure):
                _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in ('total_phys','avail_phys','total_page','avail_page','total_virtual','avail_virtual','avail_extended')]
            status = MemoryStatus()
            status.length = ctypes.sizeof(status)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return None
            return status.avail_phys / 1024**3
        meminfo = Path('/proc/meminfo')
        if meminfo.exists():
            match = re.search(r'^MemAvailable:\s+(\d+)', meminfo.read_text(), re.M)
            if match: return int(match[1]) / 1024**2
        return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') / 1024**3
    except (OSError, ValueError, AttributeError):
        return None

def system_limit(stage):
    cpu = os.cpu_count() or 2
    ram = available_memory_gb()
    budget = max(1, int((ram - .75) / (.18 if stage == 'scan' else .35))) if ram is not None else 8
    return max(1, min(12 if stage == 'scan' else (3 if stage == 'fallback' else 8), cpu * (4 if stage == 'scan' else 2), budget))

def throttled(text):
    return bool(re.search(r'429|too many requests|rate.?limit|confirm you.re not a bot|temporarily blocked', text, re.I))

def adaptive_jobs(items, worker, stage, requested=0):
    queue = deque((item, 0) for item in items)
    ceiling = min(requested, system_limit(stage)) if requested else system_limit(stage)
    target = min(ceiling, 6 if stage == 'scan' else 2)
    print(f'{stage}: capacity {ceiling}, starting {target} jobs', flush=True)
    successes = 0
    cooldown_until = 0
    recovery_until = 0
    consecutive_limits = 0
    with ThreadPoolExecutor(max_workers=ceiling) as pool:
        pending = {}
        while pending or queue:
            now = time.monotonic()
            target = min(target, system_limit(stage), ceiling)
            while queue and len(pending) < target and now >= cooldown_until:
                item, attempt = queue.popleft()
                pending[pool.submit(worker, item)] = (item, attempt)
            if not pending:
                if not queue: break
                time.sleep(min(1, max(0, cooldown_until-time.monotonic())))
                continue
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                item, attempt = pending.pop(future)
                result = future.result()
                if result.get('throttled'):
                    now = time.monotonic()
                    # All failures from the already-running batch share one cooldown.
                    if now >= cooldown_until:
                        consecutive_limits += 1
                        target = max(1, target//2)
                        ceiling = min(ceiling, target)
                        delay = min(180, 30 * 2**(consecutive_limits-1))
                        cooldown_until = now + delay
                        recovery_until = cooldown_until + 120
                        print(f'{stage}: limit detected; ceiling {ceiling}, cooldown {delay}s; retrying affected jobs', flush=True)
                    successes = 0
                    if attempt < 2:
                        queue.append((item, attempt+1))
                        continue
                elif not result.get('ok'):
                    successes = 0
                    if result.get('retryable') and attempt < 2:
                        queue.append((item, attempt+1))
                        continue
                else:
                    successes += 1
                    if successes >= max(12, target*4) and time.monotonic() >= recovery_until and target < min(ceiling,system_limit(stage)):
                        target += 1
                        successes = 0
                        print(f'{stage}: increasing to {target} jobs', flush=True)
                yield result


def quick_youtube_metadata(item):
    key, url = item
    canonical = 'https://www.youtube.com/watch?v=' + key.split(':',1)[1]
    endpoint = 'https://www.youtube.com/oembed?' + urlencode({'url':canonical, 'format':'json'})
    try:
        with urlopen(Request(endpoint, headers={'User-Agent':'MusicListDownloader/1.0'}), timeout=20) as response:
            data = json.load(response)
        if not data.get('title'): raise ValueError('oEmbed response has no title')
        return {'key':key, 'info':{'id':key.split(':',1)[1], 'title':data['title'], 'source':'oembed'}, 'ok':True}
    except HTTPError as error:
        return {'key':key, 'error':str(error), 'ok':False, 'throttled':error.code==429, 'retryable':error.code>=500, 'fallback':error.code in (401,403,404)}
    except (URLError, TimeoutError, OSError, ValueError) as error:
        return {'key':key, 'error':str(error), 'ok':False, 'retryable':True, 'fallback':True}

TAG = re.compile(r'\b(?:official\s+)?(?:music\s+video|lyric(?:s)?(?:\s+video)?|audio(?:\s+video)?|visuali[sz]er|mv|m/v)\b|เนื้อเพลง|มิวสิควีดีโอ|มิวสิควิดีโอ|มิวสิกวิดีโอ|オフィシャルビデオ|歌詞|가사|뮤직비디오|歌词|歌詞', re.I)
PROTECTED = re.compile(r'\b(live|cover|remix|acoustic|instrumental|karaoke|sped\s*up|slowed|nightcore|remaster(?:ed)?)\b|แสดงสด|คัฟเวอร์|คาราโอเกะ|คอนเสิร์ต', re.I)

def norm(s):
    s = unicodedata.normalize('NFKC', s).casefold()
    return ''.join(c for c in s if c.isalnum())

def cleaned(title):
    s = TAG.sub(' ', title)
    s = re.sub(r'\b(?:official|hd|4k|1080p|720p)\b', ' ', s, flags=re.I)
    s = re.sub(r'[\[\](){}【】「」]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip(' -|:')

def identity(info):
    title = info.get('title', '')
    versions = tuple(sorted(set(norm(x) for x in PROTECTED.findall(title))))
    # Never infer an artist from uploader/channel: lyric uploaders often differ.
    if info.get('track') and (info.get('artist') or info.get('artists')):
        artist = info.get('artist') or ' '.join(info['artists'])
        return ('metadata', norm(info['track']), norm(artist), versions)
    parts = re.split(r'\s+[-–—|]\s+', cleaned(title))
    if len(parts) == 2:
        return ('title', tuple(sorted(norm(x) for x in parts)), versions)
    return ('title', (norm(cleaned(title)),), versions)

def preference(title):
    if re.search(r'lyric|เนื้อเพลง|歌詞|歌词|가사', title, re.I): return 0
    if re.search(r'\baudio\b', title, re.I): return 1
    if re.search(r'\bmv\b|m/v|music\s+video|มิวสิ|뮤직비디오', title, re.I): return 3
    return 2

def url_key(url):
    p = urlparse(url)
    host = (p.hostname or '').lower()
    vid = None
    if host in ('youtu.be', 'www.youtu.be'): vid = p.path.strip('/').split('/')[0]
    elif host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'):
        vid = parse_qs(p.query).get('v', [None])[0]
        if not vid and p.path.startswith(('/shorts/', '/embed/')): vid = p.path.split('/')[2]
    return 'youtube:' + vid if vid else url

def command():
    local = ROOT / ('yt-dlp.exe' if sys.platform == 'win32' else 'yt-dlp')
    if local.exists(): return [str(local)]
    if shutil.which('yt-dlp'): return ['yt-dlp']
    try:
        import yt_dlp
        return [sys.executable, '-m', 'yt_dlp']
    except ImportError:
        raise RuntimeError('Install yt-dlp: python -m pip install -U "yt-dlp[default]"')

def save_json(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)

def analyze(rows, overrides):
    seen, drops, remaining = {}, [], []
    for row in rows:
        if row['url'] in overrides.get('drop', []):
            drops.append((row, None, 'manual drop')); continue
        k = url_key(row['url'])
        if k in seen:
            drops.append((row, seen[k], 'same video URL/ID')); continue
        seen[k] = row
        remaining.append(row)
    groups = {}
    for row in remaining:
        if row.get('info') and row['url'] not in overrides.get('keep', []):
            groups.setdefault(identity(row['info']), []).append(row)
    removed = set()
    for key, group in groups.items():
        if len(group) < 2 or not norm(cleaned(group[0]['info']['title'])): continue
        winner = min(group, key=lambda r: (preference(r['info']['title']), r['line']))
        for row in group:
            if row is not winner:
                drops.append((row, winner, 'same normalized song/artist; lyrics > audio > other > MV'))
                removed.add(row['line'])
    kept = [r for r in remaining if r['line'] not in removed]
    candidates = []
    for i, a in enumerate(kept):
        if not a.get('info'): continue
        for b in kept[i + 1:]:
            if not b.get('info'): continue
            x, y = norm(cleaned(a['info']['title'])), norm(cleaned(b['info']['title']))
            ratio = difflib.SequenceMatcher(None, x, y).ratio()
            if x and y and (ratio >= .78 or (min(len(x), len(y)) >= 8 and (x in y or y in x))):
                candidates.append((a, b, round(ratio, 3)))
    return kept, drops, candidates

def write_report(folder, rows, kept, drops, candidates):
    def title(r): return r.get('info', {}).get('title', '(metadata unavailable)') if r else ''
    with (folder / 'removed.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f); w.writerow(['line', 'removed_title', 'removed_url', 'kept_title', 'kept_url', 'reason'])
        for r, win, why in sorted(drops, key=lambda x:x[0]['line']): w.writerow([r['line'], title(r), r['url'], title(win), win['url'] if win else '', why])
    with (folder / 'review.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f); w.writerow(['title_A', 'url_A', 'title_B', 'url_B', 'similarity_NOT_confidence'])
        for a,b,s in candidates: w.writerow([title(a),a['url'],title(b),b['url'],s])
    with (folder / 'metadata_errors.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w=csv.writer(f); w.writerow(['line','url','error'])
        for r in rows:
            if not r.get('info'): w.writerow([r['line'],r['url'],r.get('error','')])
    (folder / 'kept.txt').write_text(''.join(r['url']+'\n' for r in kept), encoding='utf-8')
    summary=f'Input: {len(rows)}\nKept: {len(kept)}\nRemoved: {len(drops)}\nReview pairs (kept): {len(candidates)}\nMetadata errors (kept unless identical ID/manual drop): {sum(not r.get("info") for r in rows)}\n'
    (folder / 'summary.txt').write_text(summary, encoding='utf-8')
    print(summary)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--scan', action='store_true', help='reports only, no downloads')
    mode.add_argument('--download', action='store_true', help='scan then download MP3')
    parser.add_argument('--refresh', action='store_true', help='fetch metadata again')
    parser.add_argument('--workers', type=int, default=0, help='download concurrency ceiling; 0 = auto')
    parser.add_argument('--scan-workers', type=int, default=0, help='metadata concurrency ceiling; 0 = auto')
    args=parser.parse_args()
    if not 0 <= args.workers <= 128 or not 0 <= args.scan_workers <= 128:
        parser.error('worker counts must be 0 (auto) through 128')
    if not args.scan and not args.download:
        print('\n=== ดาวน์โหลดเพลงและคัดซ้ำ ===')
        print('วางไฟล์นี้ข้างรายการ URL .txt ของคุณ')
        print('1. ตรวจรายการและสร้างรายงาน (ยังไม่ดาวน์โหลด)')
        print('2. ตรวจรายการ แล้วดาวน์โหลด MP3 320K')
        print('3. วิธีติดตั้งและใช้งาน')
        print('0. ออก')
        while True:
            choice = input('เลือก [1/2/3/0]: ').strip()
            if choice == '0': return
            if choice == '3':
                print(__doc__)
                print('ชื่อที่ดึงสำเร็จจะถูกจำไว้ รอบถัดไปไม่ต้องดึงใหม่')
                print('downloaded.archive ในแต่ละโฟลเดอร์ป้องกันดาวน์โหลดวิดีโอเดิมซ้ำ')
                print('overrides.json ในโฟลเดอร์รายงาน: keep/drop ใส่ URL เพื่อกำหนดเอง')
                print('MV เดี่ยวเก็บไว้; live/cover/remix แยกจากเวอร์ชันปกติ')
                print('ตรวจจากชื่อ/metadata ไม่ได้ฟังเสียง จึงไม่รับรองว่าคัดซ้ำครบหรือไม่มีบทพูด')
                continue
            if choice in ('1', '2'):
                args.scan = choice == '1'
                if not args.scan:
                    while True:
                        count = input(f'ดาวน์โหลดพร้อมกัน [Enter/0 = อัตโนมัติ, 1–128 = เพดานที่กำหนด]: ').strip()
                        if not count:
                            break
                        if count.isdigit() and 0 <= int(count) <= 128:
                            args.workers = int(count)
                            break
                        print('กรุณาใส่ 0–128')
                break
            print('กรุณาเลือก 1, 2, 3 หรือ 0')
    cmd=command()
    files=sorted(ROOT.glob('*.txt'))
    if not files: raise RuntimeError('No .txt URL lists next to this script.')
    if not args.scan:
        for exe in ('ffmpeg','ffprobe'):
            if not shutil.which(exe) and not (ROOT / (exe+'.exe')).exists():
                raise RuntimeError('Missing '+exe+': put ffmpeg.exe and ffprobe.exe next to this script or on PATH.')
    STATE.mkdir(exist_ok=True)
    cache_path=STATE/'metadata_cache.json'
    cache=json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    for path in files:
        rows=[]
        for n,line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(),1):
            line=line.strip()
            if not line or line.startswith('#'): continue
            if urlparse(line).scheme not in ('http','https') or not urlparse(line).netloc:
                raise RuntimeError(f'{path.name}:{n}: not a URL. Only URL-list .txt files should be placed next to script.')
            rows.append({'line':n,'url':line})
        folder=STATE/path.stem; folder.mkdir(exist_ok=True)
        override_path=folder/'overrides.json'
        if not override_path.exists(): save_json(override_path, {'keep':[], 'drop':[]})
        overrides=json.loads(override_path.read_text(encoding='utf-8-sig'))
        if set(overrides.get('keep',[])) & set(overrides.get('drop',[])): raise RuntimeError('Same URL in both keep and drop: '+str(override_path))
        print('\n=== '+path.name+' ===', flush=True)
        missing = {}
        for row in rows:
            key = url_key(row['url'])
            if not args.refresh and cache.get(key):
                row['info'] = cache[key]
            else:
                missing.setdefault(key, row['url'])
        def fetch_metadata(item):
            key, url = item
            result = subprocess.run(cmd+['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-warnings']+EXTRA_YTDLP_ARGS+['--',url], capture_output=True, encoding='utf-8', errors='replace')
            try:
                full = json.loads(result.stdout)
                if result.returncode or not full.get('title') or full.get('_type') in ('playlist','multi_video'):
                    raise ValueError('No single video metadata')
                info = {k:full.get(k) for k in ('id','title','track','artist','artists','duration')}
                return {'key':key, 'info':info, 'ok':True}
            except (ValueError, TypeError):
                error = result.stderr.strip() or 'No usable video metadata'
                return {'key':key, 'error':error, 'ok':False, 'throttled':throttled(error)}
        errors = {}
        completed = 0
        print(f'Metadata: {len(missing)} unique requests; {len(rows)-sum(url_key(r["url"]) in missing for r in rows)} cached rows', flush=True)
        def accept_metadata(result):
            nonlocal completed
            completed += 1
            if result['ok']:
                cache[result['key']] = result['info']
                save_json(cache_path, cache)
                errors.pop(result['key'], None)
            else:
                errors[result['key']] = result['error']
            print(f'Metadata {completed}/{len(missing)}: {"OK" if result["ok"] else "UNRESOLVED (kept)"}', flush=True)
        fallback = [(key,url) for key,url in missing.items() if not key.startswith('youtube:')]
        quick = [(key,url) for key,url in missing.items() if key.startswith('youtube:')]
        for result in adaptive_jobs(quick, quick_youtube_metadata, 'scan', args.scan_workers):
            if not result['ok'] and result.get('fallback') and not result.get('throttled'):
                fallback.append((result['key'], missing[result['key']]))
            else:
                accept_metadata(result)
        if fallback:
            print(f'Fallback: {len(fallback)} titles via yt-dlp (separate low concurrency)', flush=True)
            for result in adaptive_jobs(fallback, fetch_metadata, 'fallback', 2):
                accept_metadata(result)
        for row in rows:
            key = url_key(row['url'])
            if key in errors:
                row['error'] = errors[key]
            elif cache.get(key):
                row['info'] = cache[key]
        kept,drops,candidates=analyze(rows,overrides)
        write_report(folder,rows,kept,drops,candidates)
        if not args.scan and kept:
            output=ROOT/path.stem; output.mkdir(exist_ok=True)
            # Each worker owns its own archive: yt-dlp processes never write the
            # same archive concurrently. Merge completed archives on the main thread.
            archive = output/'downloaded.archive'
            worker_dir = folder/'download_jobs'
            worker_dir.mkdir(exist_ok=True)
            archived = set(archive.read_text(encoding='utf-8').splitlines()) if archive.exists() else set()
            # Recover successful jobs after an interruption before a previous merge.
            for partial in worker_dir.glob('*.archive'):
                archived.update(partial.read_text(encoding='utf-8').splitlines())
            def flush_archive():
                temporary = archive.with_suffix('.tmp')
                temporary.write_text(''.join(x+'\n' for x in sorted(archived) if x), encoding='utf-8')
                temporary.replace(archive)
            flush_archive()
            archive_snapshot = tuple(sorted(archived))
            pending = []
            unresolved = [row for row in kept if not row.get("info")]
            (folder/"unresolved.txt").write_text("".join(row["url"]+"\n" for row in unresolved), encoding="utf-8")
            if unresolved:
                print(f"Deferred {len(unresolved)} URLs: title unavailable, cannot deduplicate yet. Rerun to retry.")
            for row in kept:
                if not row.get("info"): continue
                key = url_key(row['url'])
                if key.startswith('youtube:') and 'youtube '+key.split(':',1)[1] in archived:
                    continue
                pending.append(row)
            print(f'Downloading {len(pending)} songs, adaptive parallel mode. Logs: {worker_dir}', flush=True)
            def download_one(row):
                job = str(row['line'])
                job_archive = worker_dir/(job+'.archive')
                # Seed archive with previous successful downloads, including non-YouTube.
                job_archive.write_text(''.join(x+'\n' for x in archive_snapshot if x), encoding='utf-8')
                log_path = worker_dir/(job+'.log')
                download = cmd+['--ignore-config','--no-playlist',
                    '-f','ba[ext=m4a]/ba[acodec^=mp4a]/ba','-x',
                    '--audio-format','mp3','--audio-quality','320K',
                    '--download-archive',str(job_archive),
                    '-o',str(output/'%(title).160B [%(id)s].%(ext)s')]
                if (ROOT/'ffmpeg.exe').exists(): download+=['--ffmpeg-location',str(ROOT)]
                print(f'Start: {row.get("info",{}).get("title",row["url"])}', flush=True)
                with log_path.open('w', encoding='utf-8') as log:
                    result = subprocess.run(download+EXTRA_YTDLP_ARGS+['--',row['url']], stdout=log, stderr=subprocess.STDOUT)
                error_text = log_path.read_text(encoding='utf-8', errors='replace') if result.returncode else ''
                return {'row':row, 'code':result.returncode, 'partial':job_archive, 'log':log_path, 'ok':result.returncode == 0, 'throttled':throttled(error_text)}
            failures = []
            for result in adaptive_jobs(pending, download_one, 'download', args.workers):
                row, code, partial, log_path = result['row'], result['code'], result['partial'], result['log']
                archived.update(partial.read_text(encoding='utf-8').splitlines())
                flush_archive()
                partial.unlink(missing_ok=True)
                print(f'{"OK" if code == 0 else "FAILED"}: {row.get("info",{}).get("title",row["url"])}', flush=True)
                if code:
                    failures.append({'url':row['url'], 'log':str(log_path), 'exit_code':code})
            save_json(folder/'download_errors.json', failures)
            (folder/'download_status.txt').write_text(
                f'Deferred unresolved: {len(unresolved)}\nAlready archived: {len(kept)-len(unresolved)-len(pending)}\nAttempted: {len(pending)}\nFailed: {len(failures)}\n'
                'See download_errors.json and download_jobs/*.log. Rerun to retry failures.\n', encoding='utf-8')
            if failures: print('Some downloads failed. Rerun to retry; successful downloads are archived.')
    print('Done. Reports:',STATE)

if __name__=='__main__':
    interactive = len(sys.argv) == 1
    status = 0
    try:
        main()
    except KeyboardInterrupt:
        print('\nStopped. Rerun to continue.')
        status = 130
    except Exception as e:
        print('ERROR:', e)
        status = 1
    finally:
        if interactive:
            try:
                input('\nกด Enter เพื่อปิดหน้าต่าง...')
            except (EOFError, KeyboardInterrupt):
                pass
    sys.exit(status)
