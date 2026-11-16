# GERDEV AI WORKFORCE

Platform perusahaan virtual berisi karyawan AI (multi-agent) milik **Gerdy Hendraman**.
Node.js + PostgreSQL (Neon) + Vercel Functions. Tanpa framework frontend, tanpa langkah build.
Bisa dipasang sepenuhnya dari Android lewat GitHub + Vercel + Neon.

> Status jujur: kode ini diuji dengan 16 tes integrasi terhadap PostgreSQL 16 asli (AI diganti skrip tetap).
> **Belum diuji** dengan Neon, Vercel, OpenAI, Tavily, Resend atau WhatsApp sungguhan karena itu butuh akun & key Anda.
> Pasang, lalu cek halaman **Integrasi → Tes koneksi** untuk membuktikan tiap layanan benar-benar terhubung.

## Isi sistem

- **Dashboard** — semua angka dari database (karyawan, tugas, prospek, pelanggan, pesanan, omzet, pengeluaran, laba, grafik, aktivitas).
- **Karyawan AI** — 12 karyawan default otomatis dibuat saat Owner pertama dibuat; tambah/edit/nonaktifkan, rekrut dari template, ubah jabatan, beri tugas, riwayat, memori, evaluasi kinerja, batas token & biaya.
- **Mesin multi-agent** — registry, executor, orchestrator, antrean persisten, dependensi tugas, delegasi, retry, timeout, riwayat eksekusi, pelacakan token & biaya, verifikasi hasil oleh QA. Alur: Owner → AI CEO → Manajer → Pekerja → QA → Owner. Output AI berupa JSON yang divalidasi skema; tidak ada kode hasil AI yang dieksekusi.
- **Tools terkontrol** — web search, query database (read-only, workspace sendiri), pembaca/pembuat berkas, generator proyek website, kalkulator, riset bisnis, generator laporan. Setiap tool punya skema input/output, izin per karyawan, log eksekusi, status.
- **CRM** — prospek & pelanggan, deteksi duplikat, sumber informasi, riwayat komunikasi. Nomor WhatsApp **tidak pernah dikarang**: prospek dari AI tanpa bukti sumber dibuang nomornya.
- **Penjualan** — produk, penawaran, pesanan, invoice, status pembayaran. Pembayaran yang dicatat menjadi transaksi nyata.
- **Keuangan** — omzet, pengeluaran, biaya API, per unit bisnis, grafik, laporan harian/mingguan/bulanan. Tidak ada data simulasi.
- **Approval Center** — APPROVE / REJECT / REVIEW untuk kirim pesan, kirim penawaran, terbitkan invoice, deploy, pembelian, pembayaran, ubah data penting. Semua keputusan dicatat di audit log.
- **Otomasi** — jadwal & pekerjaan berulang, antrean persisten, pencegahan tugas ganda, monitor.
- **Integrasi** — OpenAI, model AI alternatif, web search, Neon, email (Resend), WhatsApp Business (Meta). Status **NOT CONNECTED** jujur bila belum diisi. Object storage belum didukung di V1 (berkas disimpan di tabel `files`).
- **Keamanan** — sesi cookie HttpOnly, hash kata sandi scrypt, CSRF, RBAC (owner/admin/manager/viewer), rate limit, validasi request, isolasi per workspace, audit log. Secret hanya di server (environment variable), tidak pernah dikirim ke browser.

## Pemasangan dari Android (tanpa terminal)

### 1. GitHub
1. Buka github.com → **New repository** → nama `gerdev-ai-workforce` → **Private** → Create.
2. Unggah seluruh isi proyek ini (**Add file → Upload files**; di Chrome Android pilih mode situs desktop bila perlu). Folder harus tetap utuh: `api/`, `dashboard/`, `migrations/`, dst. di akar repo, beserta `package.json` dan `vercel.json`.
3. Jangan pernah mengunggah file `.env`.

### 2. Neon (database BARU, terpisah dari KASIRPRO)
1. neon.tech → **Create project** baru bernama `gerdev-ai-workforce`. **Jangan** memakai project/database KASIRPRO.
2. Di dashboard Neon, salin **Connection string** (pilih yang *pooled*). Itu nilai `DATABASE_URL`.
3. Buka **SQL Editor**, tempel seluruh isi `database/schema.sql`, tekan **Run**. (Alternatif: tombol *Pasang Skema* di halaman setup aplikasi.) Skema aman dijalankan berulang.

### 3. Vercel
1. vercel.com → **Add New → Project** → impor repo GitHub tadi. Framework: *Other*. Biarkan build command kosong.
2. Buka **Environment Variables**, isi:

| Variabel | Isi |
|---|---|
| `DATABASE_URL` | connection string Neon |
| `SESSION_SECRET` | teks acak ≥ 32 karakter (juga dipakai sebagai *kunci setup* Owner pertama) |
| `OPENAI_API_KEY` | key OpenAI (atau pakai `ALT_AI_*` untuk OpenRouter/Groq/dll) |
| `SEARCH_PROVIDER` + `SEARCH_API_KEY` | opsional, tavily / brave / serper |
| `RESEND_API_KEY` + `EMAIL_FROM` | opsional, untuk kirim email |
| `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` | opsional, WhatsApp Cloud API |
| `CRON_SECRET` | opsional, amankan `/api/cron` |

3. Klik **Deploy**. Setiap kali mengubah variabel, lakukan **Redeploy**.

### 4. Membuat Owner pertama
1. Buka alamat Vercel Anda. Halaman setup muncul otomatis bila belum ada Owner.
2. Isi nama perusahaan, nama, email, kata sandi kuat, dan **kunci setup = nilai `SESSION_SECRET`**.
3. Halaman setup hanya bisa dipakai sekali. Setelah Owner ada, 12 karyawan AI, 4 unit bisnis, dan tools langsung terpasang.

### 5. Menyambungkan API
Buka menu **Integrasi**. Tiap layanan menampilkan status, tombol **Tes koneksi**, pesan error, saklar aktif/nonaktif, dan batas penggunaan. Tanpa key AI, tugas berstatus *blocked (NOT CONNECTED)* — sistem tidak membuat hasil palsu.

### 6. Menambahkan karyawan AI
Menu **Karyawan AI → Tambah** (isi jabatan, departemen, system prompt, tools, model, batas token/biaya) atau **Rekrut dari template**. Beri tugas dari halaman detail karyawan atau **Pusat Tugas**.

## Worker & batas serverless

Vercel Functions dibatasi waktu (60 dtk di konfigurasi ini), jadi pekerjaan diproses per putaran (`tick`):
- Tombol **Jalankan antrean** (Pusat Tugas/Otomasi) menjalankan satu putaran seketika.
- Vercel Cron di `vercel.json` memanggil `/api/cron` **sekali sehari** (batas paket Hobby). Untuk lebih sering, naikkan ke Vercel Pro atau panggil `/api/cron` tiap 5 menit dari layanan cron gratis (mis. cron-job.org) dengan header `Authorization: Bearer <CRON_SECRET>`.
- Tugas yang macet dipulihkan otomatis (timeout + retry berbatas). Untuk proses sangat panjang, jalankan `/api/cron` lebih sering atau pindahkan worker ke server terpisah.

## Biaya layanan eksternal (transparan)

Neon & Vercel punya paket gratis. OpenAI/model AI **berbayar per token** — biaya tercatat di menu *Penggunaan AI* (estimasi dari harga model; isi `AI_PRICE_IN_PER_M`/`AI_PRICE_OUT_PER_M` untuk model tak dikenal). Tavily/Brave/Serper punya kuota gratis terbatas. Resend punya paket gratis; WhatsApp Cloud API memakai tarif percakapan Meta.

## Pengembangan & pengujian lokal (opsional)

```bash
npm install
cp .env.example .env        # isi DATABASE_URL dan SESSION_SECRET
npm run migrate
node scripts/dev.js          # http://localhost:3000
npm run check                # pemeriksaan statis
TEST_DATABASE_URL=postgresql://user@host/db_kosong npm test   # tes integrasi (pakai database KOSONG khusus tes!)
```

## Struktur

`api/` REST (Vercel Function + `_routes/`), `engine/` orkestrasi & antrean, `agents/` template karyawan, `tools/` tools AI, `memory/` memori, `workflows/` alur default, `businesses/` unit bisnis, `database/` SQL instalasi, `migrations/`, `security/` auth & rate limit, `services/` AI/search/keuangan/integrasi, `lib/` utilitas, `dashboard/` frontend, `scripts/`, `tests/`.
