# Billiard 8-Ball Online (3D, 2 pemain)

## Menjalankan
```
node server.js          # butuh Node.js 18+, tanpa npm install
```
Buka http://localhost:3000. Untuk uji 2 pemain, buka dua jendela (satu biasa, satu incognito), daftar dua akun, lalu klik **Cari Lawan Acak** di keduanya.

Untuk dimainkan lewat internet, jalankan di hosting yang mendukung Node.js (VPS, Railway, Render, Fly.io, dll). Pasang HTTPS dan `PORT` lewat environment variable.

## Fitur
- **Akun**: daftar/masuk (password di-hash scrypt), sesi tersimpan di `data.json`.
- **Duit in-game**: koin awal 500, menang +100, kalah +20.
- **10 stik** di tab Toko (beli, lalu pakai). Stik memengaruhi power, panjang garis bidik, dan kekuatan spin.
- **Teman**: tambah lewat nama pengguna, terima/tolak, status online, tombol Tantang.
- **Matchmaking acak**: pemain yang menekan Cari Lawan dalam waktu bersamaan dipasangkan secara acak.
- **Game 3D** (Three.js): meja, bola bernomor, stik, kamera orbit dan tampak atas, aturan 8-ball (grup penuh/strip, foul, bola di tangan, bola 8).
- Server mensimulasikan setiap tembakan (otoritatif) sehingga hasil tidak bisa dicurangi lewat klien. Turn timer 75 dtk, menyerah, dan forfeit jika terputus 30 dtk.

## Kontrol
- Geser layar (atau ◀ ▶ / tombol panah): membidik. Geser vertikal: ketinggian kamera. Roda mouse / ＋－: zoom.
- Slider **Power** dan **Spin** (kiri = tarik, kanan = dorong), lalu **TEMBAK** (atau Spasi).
- Tombol **Kamera**: tampak atas, ketuk meja untuk mengarahkan. Saat bola di tangan: ketuk meja untuk menaruh bola putih, lalu **Posisi OK**.

## Deploy ke Vercel (GitHub Actions)
Vercel hanya cocok untuk **frontend** (folder `public/`). `server.js` butuh proses yang terus hidup (SSE realtime, antrean di memori, file `data.json`), jadi **tidak bisa jalan di Vercel**. Hosting backend-nya di layanan yang mendukung proses persisten (Railway, Render, Fly.io, VPS) dengan disk/volume permanen untuk `data.json`.

1. Deploy `server.js` ke hosting backend. Set environment variable `ALLOWED_ORIGIN` ke domain Vercel kamu, mis. `https://billiard.vercel.app` (boleh beberapa, pisahkan koma).
2. Buat project di Vercel (import repo, atau `vercel link` lokal). Dari `.vercel/project.json` ambil `orgId` dan `projectId`.
3. Di GitHub: Settings > Secrets and variables > Actions, isi
   - Secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
   - Variable: `API_BASE_URL` = alamat backend, mis. `https://billiard-api.onrender.com`
4. Push ke `main` = deploy production, pull request = deploy preview (workflow `.github/workflows/deploy-vercel.yml`). Matikan auto-deploy Git bawaan Vercel agar tidak dobel.

Catatan: gunakan HTTPS di backend (halaman Vercel adalah HTTPS, jadi backend `http://` akan diblokir browser).

## Struktur
- `server.js` server HTTP + SSE, `public/physics.js` fisika dan aturan (dipakai server dan klien), `public/app.js` + `index.html` klien.
- Model 3D dibuat prosedural (tanpa file aset) sehingga tidak perlu mengunduh apa pun. Ingin model dari Google/Sketchfab? Pakai `GLTFLoader` Three.js di `buildTable()`/`buildCue()` pada `app.js`.
