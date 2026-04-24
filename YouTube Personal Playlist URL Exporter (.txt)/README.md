สคริปย์ช่วยส่งออก url รายการเพลย์ลิชล์ youtube ส่วนตัวของเรา เพราะมันไม่สามารถดาวน์โหลดโดยตรงถ้าเราปิดเป็นส่วนตัวไว้ครับ 
ขั้นตอน:
- เข้าหน้าเพลย์ลิชส่วนตัวของเราแล้วกดดาวน์โหลดไฟล์แล้วนำไปดาวน์โหลดต่อใน yt-dlp หรืออะไรที่ท่านสะดวก

<img width="335" height="154" alt="image" src="https://github.com/user-attachments/assets/d5b4f4b3-c908-44f5-abfe-51d0435d88a0" />
<img width="435" height="326" alt="image" src="https://github.com/user-attachments/assets/fb053288-3acc-4b8b-8e64-333ddeacac36" />

## Install yt-dlp on Windows

First, install Chocolatey:

https://chocolatey.org/install

Then open **PowerShell / Terminal** and run:

```powershell
choco upgrade yt-dlp
```

---

## Prepare URL List

Create a `.txt` file, for example:

```text
youfilename.txt
```

Add your URLs to the file using this format:

```text
https://example.com/video-1
https://example.com/video-2
https://example.com/video-3
```

> One URL per line.

---

## Download from URL List

Download items from your URL list:

```bash
yt-dlp -a youfilename.txt
```

---

## Export as Best-Quality MP3

Download audio only and convert it to MP3 with the best quality:

```bash
yt-dlp -f bestaudio -x --audio-format mp3 --audio-quality 0 -a youfilename.txt
```

---

## Notes

- `-a youfilename.txt` reads URLs from a `.txt` file.
- `-f bestaudio` selects the best available audio source.
- `-x` extracts audio from the media.
- `--audio-format mp3` converts the audio to MP3.
- `--audio-quality 0` uses the best conversion quality.
