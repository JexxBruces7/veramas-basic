# Veramas untuk Indodax

Tampilan Veramas Anda, kini memakai harga asli Indodax secara real-time dan bisa mengirim order ke Indodax.

## Cara menjalankan (Windows)

1. Pasang **Node.js versi 18 atau lebih baru** dari https://nodejs.org (pilih LTS).
2. Ekstrak folder `veramas` ini, misalnya ke `C:\Veramas`.
3. Klik dua kali **`start.bat`**. Pertama kali, ia memasang dependensi dan membuat file `.env`.
4. Browser terbuka di **http://localhost:3000**. Jangan tutup jendela hitam (server), karena bot berjalan di sana.

Cara manual: buka terminal di folder ini, jalankan `npm install` lalu `npm start`.

## Mode simulasi (bawaan)

Tanpa API key, bot berjalan dalam **mode SIMULASI**: harga dan chart asli dari Indodax, tetapi saldonya pura-pura (Rp 10 juta, bisa ditambah lewat tombol Deposit). Coba strategi di mode ini dulu selama beberapa hari.

## Mode live (dana sungguhan)

### Indodax
1. Di Indodax, buka menu **Pengaturan → Trade API**, lalu buat API key dengan izin **view** dan **trade** saja. **Jangan aktifkan izin withdraw.**
2. Buka file `.env` dengan Notepad dan isi:
   ```
   INDODAX_API_KEY=kunci_anda
   INDODAX_SECRET_KEY=secret_anda
   LIVE_TRADING=true
   ```
3. Tutup jendela server, lalu jalankan `start.bat` lagi. Label di kiri atas berubah menjadi **LIVE · DANA ASLI**.

### Lewat tombol di aplikasi (lebih mudah)
1. Klik tombol **🔌 Hubungkan API** di header.
2. Isi **API Key** dan **Secret Key** Indodax (izin view + trade saja, tanpa withdraw).
3. Klik **🔴 Hubungkan & mode LIVE**. Server memeriksa kunci ke Indodax dulu; jika benar, mode berganti ke LIVE dan saldo asli tampil.
4. Centang "Simpan di .env" bila ingin tersambung otomatis setiap server dinyalakan. Tanpa centang, kunci hanya di memori server dan hilang saat server ditutup.
5. Untuk kembali ke simulasi, klik tombol yang sama lalu **Putuskan**. Tutup semua posisi dulu.

**Trade API V2 dan V1.** Indodax kini membuat kunci **Trade API V2** (halaman indodax.com/trade_api bertuliskan "Trade API V2"). Kunci V2 dan kunci lama (V1) tidak saling tukar: kunci V2 hanya jalan di `api.indodax.com/api/v2`, kunci V1 hanya di `indodax.com/tapi`. Bot mencoba V2 dulu, lalu V1, dan menampilkan versi yang terdeteksi di tombol header (misalnya "Indodax V2 · LIVE"). Pesan "Access denied for this API key version" berarti kunci tidak cocok dengan versi API yang dipanggil.

Tokocrypto, Binance, dompet DEX (Phantom, MetaMask), dan penyedia data dihubungkan lewat dialog yang sama; lihat **Hubungkan API: CEX, DEX, Data Intelligence** di bawah. Exchange yang belum ada di daftar bisa ditambahkan sendiri dengan **+ Tambah API**. Bot dan mode LIVE tetap memakai Indodax.

API key hanya tersimpan di file `.env` di komputer Anda dan tidak pernah dikirim ke browser. Jangan bagikan file `.env` ke siapa pun.

## Pengaman

- Ukuran Trade bot dan order manual **tidak dibatasi**; jumlahnya hanya dibatasi saldo Anda. `MAX_ORDER_IDR` di `.env` lama boleh dibiarkan, tidak dipakai lagi. Batas rugi harian (`DAILY_LOSS_LIMIT_IDR`) tetap berlaku.
- `DAILY_LOSS_LIMIT_IDR`: bot berhenti sendiri jika rugi hari ini mencapai batas ini (bawaan Rp 200.000).
- Bot selalu mati setiap server baru dinyalakan.
- Di mode live, setiap order manual dan setiap kali bot dinyalakan harus dikonfirmasi.
- Server hanya bisa dibuka dari komputer ini sendiri (localhost).

## Fitur trading

### Pilih aset
Klik tombol **🪙 BTC/IDR** di atas chart untuk membuka daftar semua pasar IDR di Indodax (cari nama atau kode koin, lihat harga, perubahan 24 jam, dan volume). Di mode LIVE, koin yang Anda pegang muncul sebagai tombol cepat. Aset hanya bisa diganti saat tidak ada posisi atau order limit terbuka, supaya bot tidak kehilangan jejak.

### Analisa saham, forex, komoditas, dan properti di chart
Di toolbar chart ada tombol emoji **📈 Saham · 💱 Forex · 🛢️ Komoditas · 🏠 Properti**. Klik salah satu untuk membuka daftar asetnya (bisa dicari, mis. "tlkm"), lalu pilih untuk dianalisa dengan indikator dan alat gambar yang sama. Di dialog pilih aset juga ada tab 🪙 Crypto, 📈 Saham, 💱 Forex, 🛢️ Komoditas, 🏠 Properti.
- Data dari Yahoo Finance (bisa tertunda ±15 menit), diperbarui tiap 30 detik.
- Hanya untuk analisa: chart utama tetap pasar Indodax untuk trading. Aset non-kripto yang dipilih dari chart utama otomatis dibuka di **chart ke-2** (layout 2 chart). Label panel memakai ikon kategorinya.

### Indikator (bisa diatur sendiri)
Klik **📈 Indikator**. Centang untuk menampilkan di chart, ubah angka sesuai selera:

- **SMA** dan **EMA** dengan **pilihan jumlah garis** (1 sampai 8 masing-masing): pilih jumlahnya, lalu atur periode dan warna tiap garis (bawaan SMA 14, EMA 21 & 50). Centang/hapus per garis.
- **EMA Cross** (bawaan 9 & 21): dua EMA dengan tanda **BUY** saat EMA cepat memotong naik EMA lambat dan **SELL** saat memotong turun. Periode dan warna (garis cepat, garis lambat, tanda BUY, tanda SELL) bisa diganti.
- **Bollinger Bands** (bawaan 20, 2): pita atas, tengah (SMA), dan bawah.
- **RSI** (bawaan 14, batas 70/30): panel sendiri di bawah candle.
- **Order Blocks**: kotak **hijau** saat struktur berubah dari turun ke naik (support utama) dan **merah** saat berubah dari naik ke turun (resistance utama), diambil dari candle berlawanan terakhir di titik balik. Kotak berhenti saat harga menutup menembusnya. Tampil di timeframe **30m, 1H, 2H, 4H, 1D, 3D, 1W**.
- **BOS & CHoCH**: garis putus-putus di level swing yang ditembus harga tutup. **BOS** = tembus searah tren, **CHoCH** = tembus berlawanan tren (tanda pembalikan).
- **MACD** (bawaan 12, 26, 9): garis, sinyal, dan histogram di panel bawah.
- **Stochastic** (bawaan %K 14, smooth 3, %D 3, oversold 20, overbought 80): panel bawah dengan garis batas.
- **Panel indikator terpisah**: Volume, Stochastic, dan MACD tampil di panel sendiri di bawah candle (seperti TradingView), masing-masing dengan sumbu harga, legenda (mis. `MACD 12 26 close 9` + nilai histogram/MACD/sinyal), dan sumbu waktu hanya di panel paling bawah. Geser/zoom waktu dan crosshair di satu panel ikut ke panel lain. Tarik garis pemisah antar panel untuk mengubah tinggi (diingat di browser).
  - Arahkan mouse ke panel untuk ikon 👁 sembunyikan, ⚙ pengaturan, 🗑 hilangkan, ⋯ menu. Klik kanan panel juga membuka menu: Pindah ke atas/bawah, Perbesar/Kecilkan panel, Samakan tinggi, Sembunyikan, Hilangkan (Del), Pengaturan….
  - **Di atas atau di bawah candle**: panel tepat di bawah candle punya menu **Pindah ke atas candle** (seperti MACD di atas chart di TradingView); dari atas, **Pindah ke bawah candle** mengembalikannya. Legenda OHLC dan gambar ikut pindah bersama candle, sumbu waktu tetap di chart paling bawah, dan posisinya diingat browser.
  - **Geser panel seperti candle**: tarik isi panel ke kanan-kiri (waktu, semua panel ikut) atau ke atas-bawah (nilai). Gulir mouse di sumbu kanan panel: **gulir ke atas memperbesar**, gulir ke bawah memperkecil (sama seperti sumbu harga candle). Klik ganda sumbu panel (atau tombol **auto** di kanan bawah) untuk kembali otomatis.
  - **Layar penuh panel**: klik ganda isi panel (MACD, Stochastic, Volume, dll.) atau menu ⋯ → **Layar penuh**. Panel itu memenuhi area chart; klik ganda lagi atau tekan Esc untuk kembali.
  - Histogram MACD memakai 4 warna: positif membesar, positif mengecil, negatif mengecil, negatif membesar (atur di 📈 Indikator → MACD).
- **Volume** (bawaan mati): batang volume di panel sendiri di bawah harga, hijau/merah menurut candle naik/turun, plus garis rata-rata SMA (bawaan 9). Periode SMA dan tiga warna bisa diganti. Boleh digabung dengan MACD dan Stochastic; panelnya tersusun berurutan.
- **Fibonacci Retracement**: level 0, 0,236, 0,382, 0,5, 0,618, 0,786, 1 dari swing tertinggi/terendah pada sejumlah candle terakhir (bawaan 100). Level utama (bawaan 0,618) digambar emas dan dipakai strategi Fibonacci Bounce.

Klik bulatan warna di samping nama indikator untuk mengganti warnanya. MACD punya warna terpisah untuk garis MACD, garis sinyal, histogram naik, dan histogram turun; Stochastic untuk %K dan %D.

Ketik angka langsung di kotaknya. Perubahan tersimpan saat pindah kolom atau menekan Enter, kapan saja, juga saat bot berjalan. Pengaturan ini untuk tampilan chart; strategi bot punya pengaturannya sendiri di kartu Konfigurasi Bot.

**Ganti timeframe dengan mengetik**: klik chart, ketik misalnya `1h`, `4h`, `15m`, `1d`, atau `1w`, lalu tekan **Enter** (seperti TradingView). Kotak kecil di tengah layar menampilkan yang diketik; Esc membatalkan. Berlaku untuk chart yang terakhir diklik.

### Fibonacci tarik sendiri (seperti TradingView)
1. Klik ikon **Fibonacci** (garis-garis bertingkat) di toolbar kiri chart.
2. Klik titik awal swing (misalnya low), lalu klik titik akhirnya (high). Fibonacci langsung tergambar dan tersimpan untuk aset itu.
3. Geser bulatan biru di ujung untuk memindah titik, atau geser garis levelnya untuk memindah seluruh Fibonacci.
4. Klik dua kali pada Fibonacci (atau tombol **⚙️ Pengaturan** yang muncul saat dipilih) untuk membuka pengaturan:
   - **Gaya**: garis tren dan warnanya, tebal dan jenis garis, perpanjang garis (kanan/kiri/keduanya), 16 level yang bisa dicentang, diubah angkanya, dan diberi warna sendiri, latar dan kepekatannya, balik (reverse), tampilkan harga, tampilkan level sebagai nilai atau persen, posisi label, ukuran teks.
   - **Koordinat**: harga dan waktu (WIB) kedua titik.
   - **Template**: simpan gaya ini sebagai bawaan untuk Fibonacci berikutnya, pakai gaya bawaan, atau kembalikan gaya standar.
5. Hapus dengan tombol **🗑️ Hapus** atau tombol Delete saat Fibonacci dipilih. Esc membatalkan gambar.

Satu Fibonacci per aset. Strategi **Fibonacci Bounce** memakai Fibonacci yang Anda gambar bila ada (dan Level utama dari menu Indikator sebagai titik belinya); bila tidak ada, bot memakai swing otomatis. Fibonacci otomatis di menu Indikator tetap tersedia terpisah.

### Chart: jenis, warna, dan layout
- **Jenis chart** (ikon candle di toolbar atas): Bars, Candles, Hollow candles, Volume candles (lebar candle mengikuti volume), Line, Area, dan Heikin Ashi.
- **⚙️ Pengaturan chart**: warna Body, Borders, dan Wick untuk candle naik dan turun. Masing-masing bisa dimatikan. Ada juga warna garis Line/Area, warna latar, dan garis grid. Tombol "Kembalikan warna bawaan" tersedia.
- **Layout** (ikon kotak terbagi): 1, 2, 3, atau 4 chart sekaligus dengan berbagai susunan.
  - Chart pertama (berlabel ⚡ chart trading) selalu aset dan timeframe trading, yaitu tempat posisi, order, dan bot.
  - Chart lain bebas: klik nama aset atau timeframe di pojok kiri atas panel untuk menggantinya, misalnya BTC 1m di kiri dan ETH 4H di kanan.
  - Semua panel bergerak live.

- **Layar penuh**: tombol ⛶ di kanan atas header chart. Chart memenuhi layar, termasuk toolbar gambar dan bar bawah. Keluar dengan Esc atau klik tombolnya lagi.
- **Zoom harga dengan gulir**: arahkan kursor ke angka harga di sisi kanan chart lalu gulir roda mouse. Gulir ke atas membuat candle membesar, gulir ke bawah mengecil. Gulir di area chart tetap memperbesar/memperkecil sumbu waktu. Klik ganda angka harga atau tombol **auto** untuk kembali otomatis.
- **Waktu candle**: sumbu waktu menampilkan jam (atau tanggal/bulan), label crosshair menampilkan tanggal dan jam candle (misalnya `29 Okt '26  15:00`), dan di kiri atas chart ada keterangan waktu + Open/High/Low/Close + Volume candle yang sedang ditunjuk. Timeframe harian ke atas menampilkan tanggal saja.
- **Bar kanan bawah**: hitung mundur sampai candle tutup, jam WIB (UTC+7) berjalan, tombol **%** (skala persen), **log** (skala logaritmik; % dan log tidak bisa aktif bersamaan), dan **auto** (skala harga otomatis). Pilihan % / log diingat di browser.

- **Geser chart bebas**: tekan dan tarik di area chart yang kosong; chart langsung ikut kursor ke kanan-kiri (waktu) dan ke atas-bawah (harga), kursor berubah jadi tangan menggenggam. Bila hanya digeser mendatar, skala harga tetap otomatis. Setelah digeser ke atas/bawah, klik **auto** di kanan bawah untuk kembali otomatis. Menarik di atas gambar tetap menggeser gambar itu.
- **Batang gulir area chart**: di samping sumbu harga. Tiap chart punya tinggi minimal (bertambah bila Volume/MACD/Stochastic dinyalakan), jadi di layout 2–4 chart tidak terpotong; gulir dengan panah (tahan untuk terus), tarik pegangannya, klik jalurnya, atau putar roda mouse di atas batang itu. Bila semuanya muat, batang tampil redup.
- **Compare (bandingkan aset)**: tombol ⊕ Compare di toolbar atas. Pilih aset lalu salah satu: **Skala % sama** (kedua aset dalam persen perubahan pada sumbu kanan), **Skala harga baru** (aset pembanding punya sumbu harga sendiri di kiri), atau **Panel baru** (tampil di panel terpisah di bawah chart). Di bagian "Sedang dibandingkan" jenis chart pembanding bisa diganti (Line, Area, Candles, Hollow candles, Bars, Heikin Ashi), begitu juga skala dan warnanya. Maksimal 8 pembanding; timeframe mengikuti chart-nya; di layout multi-chart, compare berlaku untuk panel yang sedang aktif (klik panel dulu). Legenda di kiri atas menampilkan harga & persen pembanding, dengan tombol ⚙ dan ✕.
- **USDT.D (dominasi USDT)**: tersedia di daftar Compare (paling atas) dan sebagai aset panel chart ke-2 sampai ke-4 (layout 2+ chart → klik nama aset di pojok panel → USDT.D). Tidak bisa jadi chart trading karena bukan pasar Indodax. Data dari API publik CoinGecko tanpa key (cadangan nilai terkini: CoinPaprika), nilai terbaru tiap menit.
  - **Sumber USDT.D** bisa dipilih di baris USDT.D pada daftar aset: **Otomatis** (CoinGecko, bila kena limit pindah ke sumber lain), **CoinGecko**, atau **Alternatif tanpa CoinGecko** (suplai USDT dari DefiLlama dibagi total market cap dari CoinPaprika + Yahoo Finance). Bila chart USDT.D gagal karena limit, pesan di chart punya tombol untuk langsung pindah ke sumber alternatif.
  - Riwayatnya dihitung dari market cap USDT dibagi perkiraan total market cap (8 koin terbesar), lalu titik terakhir disamakan dengan nilai USDT.D resmi CoinGecko. Bentuknya mirip CRYPTOCAP:USDT.D di TradingView tapi bisa sedikit berbeda, dan resolusinya: 5 menit untuk timeframe di bawah 1 jam, 1 jam untuk 1H–4H, harian untuk 1D ke atas.
  - Pertama kali dibuka butuh ±25 detik (CoinGecko gratis dibatasi beberapa panggilan per menit); setelah itu disimpan di `data/usdtd.json`. Opsional: isi `COINGECKO_API_KEY` (key Demo gratis dari coingecko.com) di `.env` agar lebih longgar.
- **Sembunyikan Posisi / Order / Riwayat**: tombol ▾ di kanan judul Riwayat Trade atau di kiri bar bawah chart. Kartu berganti jadi satu baris ringkas berisi jumlah posisi, order, dan riwayat; klik baris itu untuk menampilkan lagi. Pilihan diingat di browser.
- **Minimize kartu order dan bot**: tombol panah di kanan judul kartu Market/Limit Order dan Konfigurasi Bot menciutkan kartu menjadi judulnya saja; klik lagi untuk membuka.
- **Chart penuh ke kanan**: tombol chart penuh (ikon panel kanan) di toolbar chart (atau klik ikon di judul kartu order/bot) menutup sementara kolom order manual dan bot, sehingga chart melebar sampai kanan. Tab kecil di tepi kanan layar mengembalikannya. Pilihan diingat browser.
- **Minimize header**: tombol panah kecil di header menyembunyikan baris saldo dan tombol, lalu menggantinya dengan satu baris tipis berisi Saldo, Equity, P&L, dan status bot. Klik **▾ Tampilkan header** di baris itu untuk membukanya lagi. Pilihan diingat browser.
- **Order Book**: tombol Order Book di toolbar atas membuka kolom bid/ask di kanan chart (aset trading). Ask (merah) di atas, harga terakhir + spread di tengah, bid (hijau) di bawah, latar menunjukkan kedalaman kumulatif, dan bar B/S di bawah menunjukkan perbandingan nilai bid dan ask. Tiga ikon di atas: bid & ask, hanya bid, atau hanya ask (bisa digulir). Klik satu baris untuk mengisi harga order limit. Data dari Indodax, diperbarui tiap 2 detik.

### Toolbar gambar (kiri chart)
Kursor, Garis tren, Garis horizontal, Fibonacci, Kotak, Kuas, Teks, Ikon/emoji, Penggaris, Zoom, Sembunyikan semua gambar, dan menu tempat sampah.

- **Menu tempat sampah** (seperti TradingView): klik ikon 🗑 untuk memilih **Hapus N gambar**, **Hapus N indikator**, atau **Hapus N gambar & indikator**. Centang **Selalu hapus gambar terkunci** bila gambar yang dikunci ikut dihapus (pilihan diingat browser); tanpa centang, gambar terkunci dibiarkan.
- **Jenis garis**: di bilah gambar yang dipilih ada pilihan **Garis** (lurus), **Putus-putus**, dan **Titik-titik**. Ikon gembok **mengunci** gambar supaya tidak tergeser tanpa sengaja.

- Gambar disimpan per aset dan tampil di semua panel yang membuka aset itu.
- Dengan kursor, klik sebuah gambar untuk memilihnya. Seret titiknya atau badannya untuk memindah. Bilah kecil berisi warna, tebal garis, perpanjang garis (tren), edit teks, dan Hapus.
- Undo/Redo juga mencatat hapus lewat menu tempat sampah.
- Klik dua kali pada teks untuk mengeditnya, dan pada Fibonacci untuk membuka pengaturannya.
- **Penggaris**: cukup **klik sekali** di titik awal, gerakkan mouse (ukuran mengikuti), lalu klik lagi untuk selesai. Menekan dan menarik juga tetap bisa. Menampilkan selisih harga, persen, jumlah candle, dan lama waktu.
- **Zoom**: tarik kotak di rentang yang ingin diperbesar.
- **Undo / Redo** (panah di toolbar atas, atau Ctrl+Z / Ctrl+Y) membatalkan atau mengulang perubahan gambar: membuat, menggeser, mengubah warna, menghapus, dan Hapus semua.
- Esc membatalkan alat yang sedang dipakai. Delete menghapus gambar yang dipilih.

### Alert harga
Klik **⏰ Alert**. Pilih aset dan kondisinya:
- menyentuh harga (naik atau turun),
- naik menembus harga,
- turun menembus harga,
- masuk area harga (dua batas).

Isi harganya, atau pakai tombol cepat dan **📍 Pilih di chart**. Lalu pilih **Setiap kali** atau **Sekali saja**, tambahkan catatan bila perlu, dan pilih apakah memakai suara.

- Alert dicek oleh server tiap ada harga baru, jadi tetap jalan walau tab browser ditutup, selama server menyala.
- Saat alert berbunyi, muncul notifikasi emas dengan suara. Bila Anda mengizinkan notifikasi browser, muncul juga notifikasi Windows.
- Garis 🔔 tampil di chart. Alert "setiap kali" punya jeda 30 detik supaya tidak berbunyi terus saat harga bolak-balik di garis. Alert area berbunyi lagi setelah harga keluar lalu masuk area lagi.
- Daftar alert bisa dimatikan, diaktifkan lagi, atau dihapus. Alert disimpan di `data/alerts.json`.

### Bar replay
Klik **⏪ Replay**, lalu klik candle di **chart mana saja** (chart 1, 2, 3, atau 4) sebagai titik mulai. Label replay menunjukkan chart yang sedang diputar.
- Chart berhenti di titik itu. Gunakan ▶/⏸ untuk memutar, ⏭ untuk maju satu candle, dan pilih kecepatan 0,5x sampai 10x.
- **📍 Titik mulai** memilih titik baru, **✕ Keluar** kembali ke chart live.
- Replay memuat sampai 1.000 candle terakhir. Indikator ikut dihitung ulang. Bot dan posisi tidak terpengaruh.

### Dashboard bot
Tombol **📊 Buka dashboard bot** di kartu bot membuka pantauan bot secara langsung (diperbarui tiap 2 detik):
- Harga, hitung mundur candle berikutnya, P&L posisi terbuka, P&L bot hari ini, total P&L bot, dan persentase menang.
- Daftar syarat strategi (✓/✕ beserta nilainya) untuk **candle terakhir yang tutup** dan **candle yang sedang berjalan**, dengan keterangan jarak ke sinyal (misalnya "%K perlu turun 12,4 poin lagi").
- Grafik kecil indikator strategi: %K/%D, histogram MACD, atau harga terhadap zona Fibonacci.
- Posisi bot dengan bilah SL → harga sekarang → TP, dan order limit bot dengan jaraknya.
- Log aktivitas (bot dinyalakan, tiap candle tutup, sinyal, order, terisi, ditutup, dibatalkan, error), bisa difilter dan dibersihkan, serta daftar trade bot terakhir.
- Tombol jalankan / hentikan bot.

### Riwayat trade
Ikon 🗑️ di judul **Riwayat Trade** menghapus daftar riwayat. Total P&L di header tidak berubah. Di mode LIVE, riwayat di aplikasi Indodax tidak ikut terhapus.

### Slider alokasi saldo
Di bawah **Jumlah (IDR)** (Market maupun Limit) dan **Ukuran Trade** bot ada slider 0% sampai 100%. Geser atau klik 0%, 25%, 50%, 75%, 100% untuk mengisi jumlah dari persentase saldo IDR yang tersedia (saldo simulasi atau saldo Indodax asli). Tombol panah keyboard menggeser 1% per tekan. Tidak ada batas per order, baik untuk order manual maupun Ukuran Trade bot; 100% berarti seluruh saldo yang tersedia. Mengetik angka sendiri juga menggeser slider.

### Stop Loss / Take Profit opsional (order manual)
Di kartu Market/Limit Order ada sakelar di samping label **Stop Loss (%)** dan **Take Profit (%)**. Matikan salah satu atau keduanya bila tidak ingin posisi dijual otomatis; kolomnya bertuliskan "Tanpa Stop Loss" / "Tanpa Take Profit", tabel posisi menulis "tanpa SL/TP", dan garisnya tidak digambar di chart. Posisi seperti itu hanya ditutup lewat tombol Tutup atau Jual limit. Pilihan sakelar diingat di browser. Bot tetap selalu memakai Bot SL dan Bot TP.

### Jual sekarang (tombol merah)
Di bawah tombol hijau **BELI SEKARANG** ada tombol merah **JUAL SEKARANG**, di tab Market maupun Limit.
- **Market**: menjual posisi spot aset ini di harga pasar. Bila kolom Jumlah kosong atau ≥ nilai posisi, semua posisi dijual; bila lebih kecil, hanya senilai jumlah itu (posisi terlama dijual lebih dulu, posisi dipecah bila perlu).
- **Limit**: memasang order jual limit di harga yang diisi, untuk semua posisi atau sebagian.
- Di bawah tombol tampil berapa yang akan dijual. Tombol nonaktif bila belum ada posisi. Di mode LIVE ada konfirmasi dulu.
- Di kartu bot (di bawah kotak status) ada tombol **Jual sekarang** yang menjual semua posisi bot di aset ini dengan harga pasar. Bot tetap berjalan dan bisa membuka posisi baru sesuai sinyal; hentikan bot dulu bila tidak ingin begitu.
- Di tab **FUTURES**, tombol hijau menjadi **BUKA LONG** dan tombol merah **BUKA SHORT**.

### Order limit
Di kartu order, pilih tab **Limit**, isi harga (ada tombol cepat: harga pasar, -0,5%, -1%, -2%, -5%), jumlah rupiah, Stop Loss, dan Take Profit.

- **Beli limit**: dana tertahan sampai harga tercapai. Setelah terisi, posisi dibuat dan Stop Loss/Take Profit dihitung dari harga isi.
- **Jual limit** untuk posisi yang sudah ada: tombol **Jual limit** di tabel Posisi Terbuka. Bila order jual limit aktif, Take Profit otomatis ditiadakan; Stop Loss tetap menjaga posisi dan membatalkan order limit lebih dulu sebelum menjual.
- Tabel **Order Limit Terbuka** menampilkan order, jumlah yang sudah terisi, dan tombol **Batalkan**. Garis emas di chart menunjukkan harga order.
- Mode simulasi mengisi order saat harga menyentuh level. Mode LIVE mengirim order sungguhan ke Indodax dan memeriksa statusnya tiap 4 detik. Terisi sebagian ditangani.
- Pengaman: harga limit tidak boleh menyimpang lebih dari 30% dari harga pasar, maksimal 20 order terbuka, batas rugi harian tetap berlaku. Order limit manual tidak dibatasi per order.
- Order limit yang sudah dipasang di Indodax tetap hidup walau server dimatikan. Cek juga lewat aplikasi Indodax bila perlu.

### Konfigurasi bot
Urutan di kartu **🤖 Konfigurasi Bot**:

1. **Strategi** dan **Timeframe strategi**. Tiap strategi punya timeframe sendiri, terpisah dari timeframe chart. Bot mengambil candle timeframe itu sendiri, jadi chart boleh dibuka di 1m sementara bot bekerja di 4H.
2. **Pengaturan strategi**, berbeda per strategi (lihat di bawah).
3. **Ukuran Trade** dengan slider alokasi.
4. **Jenis order beli bot**:
   - **Market**: beli langsung di harga pasar.
   - **Limit**: pasang order beli X% di bawah harga saat sinyal, lalu batalkan otomatis bila belum terisi setelah N candle.
5. **Bot SL** dan **Bot TP** dalam persen dari harga beli. Untuk strategi Fibonacci, TP mengikuti level Fibonacci.
6. **Cek sinyal**:
   - **Saat candle tutup** (lebih aman): sinyal dihitung saat candle timeframe strategi selesai.
   - **Langsung**: dicek tiap beberapa detik pada candle yang sedang berjalan. Lebih cepat, tetapi sinyal bisa hilang lagi sebelum candle tutup.

Kotak status di kartu bot dan badge "Sinyal bot" di atas chart menunjukkan alasan sinyal saat ini, misalnya "Stochastic %K 14,2 di bawah 20". Di bawah kotak status ada tombol **▶ Jalankan bot** / **⏹ Hentikan bot** yang menjalankan hanya strategi yang dipilih, dengan timeframe dan pengaturannya. Bot membuka satu posisi sekali waktu (atau dua untuk target Fibonacci separuh-separuh), paling banyak satu kali masuk per candle. Semua pengaturan bisa diubah saat bot berjalan dan berlaku di sinyal berikutnya. Mematikan bot ikut membatalkan order limit beli bot yang belum terisi.

### Empat strategi utama

**Stochastic di bawah**
- Beli saat Stochastic %K berada di bawah **Batas bawah** (bawaan 20) di timeframe strategi.
- Keluar lewat Bot TP atau Bot SL.
- Bisa diatur: %K, Smooth, %D, Batas bawah, pilihan "Tunggu %K memotong naik %D dulu", dan syarat tidak membuat LL.

**MACD jadi hijau, tanpa LL**
- Beli saat histogram MACD berubah dari merah ke hijau (garis MACD memotong naik garis sinyal) pada candle yang tidak membuat lower low.
- "Tidak membuat LL" artinya low candle sinyal tidak lebih rendah dari low terendah N candle sebelumnya (bawaan 5).
- Keluar lewat Bot TP atau Bot SL.
- Bisa diatur: periode Cepat, Lambat, Sinyal, syarat LL dan N candle.

**Fibonacci pantul, tanpa LL**
1. Tarik Fibonacci di chart dengan **📐 Fibonacci** dari **high ke low** swing terakhir.
2. Bot membeli saat harga berada di zona bawah Fibonacci (bawaan sampai level 0,236 dari low) dan candle tidak menembus low Fibonacci (tidak membuat LL).
3. Bot menjual otomatis di level **0,5**, **0,618**, atau **separuh di 0,5 dan separuh di 0,618**. Harga target mengikuti level yang tampil di chart.
4. Stop Loss bisa dihitung dari harga beli atau di bawah low Fibonacci (Bot SL % di bawah low).

Kotak kuning di kartu bot menampilkan low, high, batas zona beli, dan harga target. Tanpa Fibonacci di aset itu, bot tidak membeli.

**Bollinger Band (sentuh pita)**
- Beli saat low candle **menyentuh pita bawah** Bollinger, jual saat high candle **menyentuh pita atas**.
- Bisa diatur: periode (bawaan 20), deviasi k (bawaan 2), dan syarat tidak membuat LL. Bot SL/TP tetap berlaku.
- Dashboard bot menampilkan jarak harga ke pita bawah dan grafik harga dengan ketiga pita.

### Uji strategi di data lalu
Tombol **🧪 Uji strategi ini di data lalu** di kartu bot menguji strategi yang sedang dipilih untuk bot (bukan semua strategi) pada sekitar 1.000 candle terakhir aset yang sedang dibuka, di timeframe strategi dan dengan jenis order bot (market atau limit), memakai Stop Loss, Take Profit, dan biaya Indodax. Strategi Fibonacci pantul hanya diuji pada candle setelah Fibonacci Anda digambar. Hasilnya: jumlah trade, persentase menang, total untung/rugi, penurunan terdalam, dan perbandingan dengan beli lalu tahan. Di bawahnya ada daftar trade. Hasil masa lalu tidak menjamin hasil ke depan.

### Cara uji bot di simulasi
1. Pastikan tombol API bertuliskan **Mode simulasi** (bila tertulis LIVE di kiri atas, klik tombol API lalu **Putuskan**).
2. Pilih aset, lalu di kartu bot pilih strategi dan timeframe strategi. Timeframe 1m atau 15m memberi sinyal lebih sering, jadi lebih cepat terlihat hasilnya. Untuk Fibonacci pantul, tarik Fibonacci dulu.
3. Jalankan **🧪 Uji strategi** untuk melihat bagaimana strategi itu bekerja di data lalu.
4. Atur Ukuran Trade (bisa lewat slider), jenis order, Bot SL, Bot TP, dan cara cek sinyal, lalu klik **▶ Jalankan bot** di bawah kotak status (atau **BOT OFF** di header). Keduanya menjalankan hanya strategi yang Anda pilih dengan pengaturannya.
5. Biarkan server menyala. Pantau Posisi Terbuka dan Riwayat Trade; P&L di header menghitung semuanya. **Reset akun simulasi** mengembalikan saldo ke awal.

### Persen P&L di header
Di samping **Unrealized P&L** tampil persen untung/rugi terhadap modal posisi yang masih terbuka. Di samping **Total P&L** tampil persen terhadap modal awal simulasi (saldo awal + deposit), atau terhadap modal awal perkiraan di mode LIVE.

### Angka bertitik dan pilihan IDR / USD
Di dalam kolom tampil simbol **Rp**, dan berubah menjadi **$** hijau saat memilih USD (petunjuknya juga menjadi "Jumlah USD"), jadi selalu jelas mata uang yang sedang diketik.
Semua kolom jumlah (Jumlah/Margin, harga limit, Ukuran Trade bot, ukuran backtest) menampilkan titik ribuan: 1.000, 10.000, 1.000.000. Ketik angka biasa, titiknya muncul sendiri. Di kolom Jumlah/Margin dan Ukuran Trade bot ada tombol **IDR | USD**. Dengan USD, Anda mengetik dalam dolar (koma untuk desimal, misalnya 12,5). Di bawahnya tampil perkiraan rupiah, dan order tetap dikirim dalam rupiah. Kursnya kurs USDT/IDR dari Indodax, diperbarui tiap menit. Pilihan IDR/USD diingat browser.

### Bot: SL/TP opsional dan tanpa batas ukuran
Bot SL dan Bot TP masing-masing punya sakelar. Bila dimatikan, posisi bot dibuka tanpa Stop Loss atau tanpa Take Profit. Bila keduanya mati, posisi hanya tertutup oleh sinyal jual bot (spot) atau tombol Tutup, dan muncul peringatan. Ukuran Trade bot tidak dibatasi.

### Futures dan leverage (simulasi)
Indodax belum menyediakan API futures untuk aplikasi seperti ini, jadi futures **hanya berjalan di mode simulasi** dengan harga asli Indodax. Mode LIVE menolak order futures.
- Di kartu order klik **FUTURES**, pilih **Isolated** atau **Cross**, lalu buka posisi dengan tombol hijau **BUKA LONG** atau merah **BUKA SHORT** (pilihan Long/Short di atas hanya menandai tombol mana yang disorot). Atur leverage lewat tombol leverage (misalnya **10x ✎**).
- Dialog **Ubah Leverage**: 1x sampai 100x dengan slider, tombol − / +, atau ketik angka. Peringatan menunjukkan seberapa jauh harga boleh bergerak sebelum likuidasi. Leverage baru berlaku untuk order berikutnya.
- Angka yang Anda ketik adalah **margin**. Nilai posisi = margin × leverage. Biaya 0,05% dari nilai posisi saat buka dan tutup.
- Harga likuidasi (isolated) ≈ harga masuk × (1 − 1/leverage + 0,5%) untuk Long dan × (1 + 1/leverage − 0,5%) untuk Short. Pada isolated, rugi maksimal sebesar margin. Pada cross, seluruh saldo ikut menahan posisi: likuidasi lebih jauh (bisa tidak ada bila saldo besar), tetapi saldo bisa ikut habis.
- SL/TP futures dihitung dari pergerakan harga (Short: SL di atas, TP di bawah). Posisi menampilkan LONG/SHORT, leverage, harga likuidasi (garis oranye di chart), margin, nilai posisi, dan ROE.
- Di kartu bot, **Pasar: Futures** membuat bot membuka posisi **Long** dengan leverage dan margin mode bot sendiri (terpisah dari order manual). Bot futures hanya memakai order market.
- Belum ada funding rate dan order limit untuk futures. Perhitungan cross margin adalah perkiraan.

### Financial Market: Market Intelligence, Research Intelligence, Encrypt Intelligence
Tombol **Financial Market** di kiri atas membuka pilihan tiga laporan seperti kampus Financial Market Bruces Capital:
- **Market Intelligence (zona A)**: Laporan Market Intelligence dengan format tim Rey, Nadia, Dimas, Sinta, dan Bayu: total market cap, volume, Altcoin Season, dominasi BTC; Fear & Greed Index; derivatif (open interest, funding, rasio long/short BTC & ETH); Whale & On-Chain (treasury Bitcoin perusahaan publik, atau transfer whale bila Arkham dihubungkan); 10 aset besar; narasi tren; koin tren (CoinGecko + volume terbesar Indodax); makro & likuiditas (stablecoin, USDT.D, kurs USDT/IDR, rasio ETH/BTC); berita hari ini; dan **🧭 Kesimpulan Utama** di akhir.
  - **Kesimpulan Utama** merangkum seluruh laporan: skor gabungan, label (Angin pendukung / Campuran / Angin lawan), satu poin per bagian (sentimen, derivatif, whale, 10 aset besar, narasi, tren, likuiditas, berita) bertanda positif/negatif, dan hal yang perlu dipantau. Kotak di atas laporan menampilkan ringkasannya dengan tautan ke kartu lengkap.
  - Sumber tanpa kunci: CoinGecko, alternative.me (Fear & Greed), Binance Futures publik, Indodax, RSS. Laporan di-cache 10 menit; **Buat Laporan** mengambil ulang. Lima laporan terakhir disimpan di browser dan ringkasannya tampil di tombol header.
  - Altcoin Season di sini perkiraan: persentase 50 koin teratas (tanpa stablecoin/wrapped) yang mengungguli BTC dalam 30 hari. Kesimpulan Utama adalah ringkasan otomatis dari angka laporan, bukan prediksi.
  - Laporan asli di artifact Bruces Capital memakai CoinMarketCap lewat konektor Claude dan tersimpan di browser artifact itu, sehingga tidak bisa dibaca aplikasi lokal; aplikasi ini menyusun laporan sendiri dengan format yang sama. Bila Binance diblokir di jaringan Anda, bagian Derivatif menampilkan pesan galat dan bagian lain tetap jalan.
  - **Derivatif** kini mencoba Binance Futures, lalu Bybit, lalu OKX (masing-masing ditunggu 6 detik), sehingga pesan "This operation was aborted" (Binance diblokir ISP) tidak lagi membuat bagian ini kosong. Bursa yang dipakai tertulis di laporan. Ditambah ringkasan **semua bursa** dari CoinGecko: total open interest perpetual BTC & ETH, funding rata-rata tertimbang OI, dan pangsa bursa terbesar. Bila **CoinGlass** dihubungkan, tampil juga likuidasi 24 jam (long/short) semua bursa.
  - **Narasi Tren** kini menampilkan 8 sektor terkuat dan 4 sektor terlemah (24 jam) beserta market cap, koin teratas tiap sektor, dan jumlah sektor yang naik, sehingga kotaknya penuh tapi tetap rapi.
  - Bila **Glassnode** dihubungkan, Whale & On-Chain menampilkan alamat aktif BTC dan arus bersih BTC ke exchange.
- **Research Intelligence (zona B)**: riset satu koin dengan format laporan seperti divisi Research Intelligence Bruces Capital: Research Coin (Raka), Tokenomics Detail (Tika), Research Technical (Farel), Whitepaper Assets (Laras), dan Berita (Yoga). Pilih aset lalu **Buat Riset**.
- **Unlock token** (di Tokenomics Detail, ringkas): jumlah supply yang belum beredar, lalu **unlock berikutnya** (tanggal, sisa hari, jumlah token, % alokasi, nilai USD) dan total yang terbuka 30 hari ke depan. Jadwal unlock memakai **Messari** (hubungkan di Hubungkan API → Data Intelligence); tanpa Messari hanya tampil supply yang belum beredar.
- Data harga, kapitalisasi, dan supply dari CoinGecko. Level support/resistance dihitung dari candle harian Indodax (pivot, Fibonacci 90 hari, SMA/EMA 7/30/200).
- Whitepaper berisi tautan resmi dan tiga kalimat pertama deskripsi CoinGecko (bahasa Inggris). Berita dari RSS CoinDesk, Cointelegraph, dan Decrypt (bahasa Inggris), disaring untuk aset tersebut. Sumber berita bisa diganti lewat `RSS_FEEDS` di `.env`.
- Lima riset terakhir disimpan dan ringkasannya tampil di tombol header.
- **Encrypt Intelligence (zona E)**: lihat bagian Encrypt Intelligence di bawah.
- **Investment Intelligence (zona D)** berjalan di artifact Bruces Capital (Divisi → Financial Market → Launch Investment Intelligence), bukan di aplikasi ini: isi data Anda untuk Management Portfolio, lalu Strategy Investments, Value Investing, Monte Carlo Analysis, dan Risk Condition menyusun laporan.

### Encrypt Intelligence: Wallet Treasury dan Whale Alarm
Pengganti "Advanced Intelligence". Lima analis bekerja berurutan, masing-masing membaca hasil divisi sebelumnya:
1. **Wallet Treasury (Gilang)**: daftar wallet yang Anda masukkan di menu **Crypto** (kartu Wallet Treasury): alamat, label, **sumber** (Arkham Intelligence, Etherscan, Solscan, BscScan, DeBank, Nansen, Whale Alert, Lookonchain, Mempool/Blockchair, X, Lainnya), jaringan (otomatis dari alamat), dan tautan sumber. Total aset tiap wallet.
2. **Whale Order (Putri)**: transaksi beli/jual/kirim/terima terbesar dalam USD dengan format ringkas (mis. **$1,53M**, **$2,1B**), total beli dan jual 7 hari.
3. **Whale Info (Rangga)**: label **🐟 ikan, 🦈 hiu, 🐋 paus** beserta alasannya. Kriteria: paus = aset ≥ $10M atau satu transaksi ≥ $1M atau volume 7 hari ≥ $5M; hiu = aset ≥ $1M atau transaksi ≥ $100K atau volume ≥ $500K; selain itu ikan.
4. **Whale Assets (Mega)**: aset yang disimpan tiap wallet dan gabungan semua wallet.
5. **Whale Alarm (Rizky)**: notifikasi di layar (dengan suara, dan notifikasi browser bila diizinkan) saat wallet melakukan transaksi ≥ batas (bawaan $1.000.000). Atur batas dan interval cek (1–60 menit); **Cek sekarang** untuk mencoba.

- Buka lewat **Financial Market → Encrypt Intelligence**, atau langsung `http://localhost:3000/#ei` (dipakai tombol Launch di Bruces Capital).
- Data on-chain tanpa kunci: **Blockscout** (Ethereum, Base, Arbitrum, Optimism, Polygon), **mempool.space** (Bitcoin), RPC Solana + harga Jupiter. Bila Arkham dihubungkan, nama entitas wallet ikut tampil. Wallet BNB Chain bisa disimpan tetapi datanya belum terbaca tanpa kunci; Tron belum didukung.
- Wallet disimpan di `data/wallets.json` (tidak ikut di zip). Alarm hanya berjalan selama server menyala.

### Backtest
Dialog **Uji strategi** kini menampilkan enam kotak ringkasan (Trade, Menang, Total P&L, % per modal, Penurunan terdalam, Beli-tahan) sebelum tabel.

### Hubungkan API: CEX, DEX, Data Intelligence
Klik tombol **Hubungkan API** di header. Dialognya punya tiga tab:

**CEX (exchange terpusat)**
- **Indodax**: dipakai untuk **trading LIVE** dengan chart, bot, dan order manual. Kunci view + trade, tanpa withdraw.
- **Tokocrypto** dan **Binance**: portofolio (aset, jumlah, perkiraan nilai rupiah) dan **order spot manual** (market/limit, beli/jual, daftar order terbuka, batalkan) langsung dari dialog.
  - Order hanya bisa bila Anda mencentang **Izinkan trading** saat menghubungkan, dan kuncinya memang berizin trading (Binance: "Enable Spot & Margin Trading"; Tokocrypto: izin trade). Tanpa centang, koneksi baca saja.
  - Kunci yang punya izin **withdraw selalu ditolak**. Setiap order meminta konfirmasi dulu karena memakai dana sungguhan.
  - Jumlah order bisa dalam USDT/IDR (quote) atau jumlah koin; ukuran dibulatkan mengikuti aturan bursa (step size, tick size, minimal nilai order).
  - Bot tetap hanya berjalan di Indodax.
- **+ Tambah API**: exchange lain (mis. Pintu, Reku, Bybit, OKX) dengan URL dasar, kunci, dan cara autentikasi (header, query, bearer, atau HMAC). Setelah disimpan, **Penjelajah API** memanggil endpoint exchange itu (GET/POST/DELETE) untuk cek saldo atau order sesuai dokumentasinya.

**DEX (dompet di browser)**
- **Phantom · Solana**: hubungkan dompet Phantom, lihat saldo SOL dan token, lalu **swap lewat Jupiter**. Transaksi ditandatangani di jendela Phantom; server tidak pernah memegang kunci dompet.
- **MetaMask · EVM** (juga Rabby, OKX Wallet, Phantom EVM): pilih jaringan (Ethereum, BNB Chain, Base, Arbitrum, Polygon, Optimism, Avalanche), lalu **swap lewat KyberSwap**. Bila perlu, dompet meminta persetujuan (approve) token dulu.
- Quote menampilkan perkiraan hasil, minimal diterima (slippage), dan rute. **Swap DEX adalah transaksi on-chain sungguhan** dan tidak bisa dibatalkan setelah ditandatangani.
- **+ Tambah API**: agregator atau DEX lain lewat API kustom.

**Data Intelligence**
- **Arkham Intelligence**: transfer whale ≥ $10 juta 24 jam di Market Intelligence (ubah lewat `ARKHAM_MIN_USD`).
- **CoinGlass** (likuidasi, OI, funding), **Glassnode** (metrik on-chain), **Messari** (riset & metrik aset, **jadwal unlock token** di Research Intelligence), **CoinMarketCap** (peringkat, Fear & Greed, global; dipakai lewat Penjelajah API). Kunci diperiksa saat dihubungkan.
- **+ Tambah API**: penyedia data lain dengan kunci Anda; ada preset untuk beberapa layanan populer. Hasilnya bisa dicoba lewat Penjelajah API.

Centang **Simpan kunci di .env** agar tersambung otomatis saat server dinyalakan ulang. **Putuskan** menghapus kunci dari memori server dan dari .env. API kustom disimpan di `data/custom-apis.json` di komputer Anda (tidak ikut di zip). Kunci tidak pernah dikirim ke browser, dan Penjelajah API hanya boleh memanggil alamat dasar API itu sendiri.

### Menu pasar di kiri (sidebar)
Ikon di sisi kiri layar membuka halaman pasar, urutannya: Trade Intelligence, Crypto, Saham, Forex, Commodities, **Property**, Macro Economy, **Macro Global**. Tombol paling bawah di menu itu menyembunyikannya; tab kecil di tepi kiri layar menampilkannya lagi (tidak menutupi tulisan). Halaman terakhir diingat browser. Header otomatis merapat (dan menjadi dua baris di layar sempit) agar saldo, P&L, dan tombol tidak bertumpuk saat menu terbuka.
- **Trade Intelligence**: dashboard trading ini, tanpa perubahan.
- **Crypto**: tiga kolom sejajar: Semua Koin (Top 100, naik/turun, cari); chart koin terpilih + kartu **Wallet Treasury** (masukkan alamat wallet dari Arkham, Etherscan, dll. dan tandai sumbernya, filter per sumber); Trending CoinGecko + **Berita kripto** yang mengisi kolom sampai bawah.
- **Chart di semua halaman pasar** (Crypto, Saham, Forex, Commodities, Property): pilih **🕯 candle** atau **📈 garis**, dan rentang **1D sampai ALL**. ALL menampilkan riwayat sejak aset itu ada (BTC & ETH sejak 2010/2015 lewat Coin Metrics, lainnya sejak data Yahoo Finance tersedia); tahun awal tertulis di chart.
- **Saham**: data IDX: saham teraktif dengan **nilai transaksi per emiten** (mis. 2,00 T), net beli/jual asing, IHSG dengan chart dan **Kapitalisasi** pasar, ringkasan pasar (volume, nilai, frekuensi, naik/turun), aktivitas asing–domestik, dan pergerakan dengan tab **🔥 Trending, 📈 Naik, 📉 Turun**. Klik saham untuk melihat chart-nya. Bila situs IDX menolak akses dari jaringan Anda, halaman memakai Yahoo Finance (saham LQ45) sebagai cadangan: nilai transaksi diperkirakan dari volume × harga (tanda ≈) dan kapitalisasi dari jumlah 45 saham utama.
- **Forex**: pasangan mata uang utama, chart, dan kurs Rupiah. Tanpa MetaTrader 5, harga dari Yahoo Finance (tertunda beberapa menit). Untuk harga bid/ask langsung dari **MetaTrader 5**: buka terminal MT5 dan login, pasang Python 3.9+, jalankan `pip install MetaTrader5`, lalu klik dua kali **`mt5_bridge.bat`** (jembatan lokal di `http://127.0.0.1:5005`, hanya membaca harga, tidak mengirim order). Halaman Forex otomatis memakai MT5 bila jembatan aktif.
- **Commodities**: emas, perak, minyak WTI & Brent, gas alam, tembaga, dan lainnya (harga futures dari Yahoo Finance; investing.com tidak punya API publik, jadi tiap baris punya tautan ke halamannya), **Emas dalam Rupiah** dan **Perak dalam Rupiah** (per gram dan per 10 gram, perkiraan) sejajar di bawah chart, naik/turun tertinggi.
- **Property**: catat listing properti Indonesia sendiri (judul, jenis, harga, kota/alamat, **tahun dibangun**, luas tanah/bangunan, kamar, **kontak + WhatsApp/telepon**, tautan iklan), cari, filter jenis, urutkan. Tombol cepat mencari di Rumah123, 99.co, Lamudi, OLX, dan Pinhome untuk kota dan jenis yang sama. **Simulasi KPR** (DP, bunga, tenor → cicilan per bulan) dan **saham properti IDX** (BSDE, CTRA, PWON, SMRA, dll.) dengan chart. Listing disimpan di `data/property.json`. Belum ada API publik listing properti Indonesia, jadi data listing diisi sendiri.
- **Macro Economy**: S&P 500, Nasdaq, Dow, IHSG, Nikkei, Hang Seng, indeks dolar, imbal hasil US 10 tahun, VIX, USD/IDR, emas, minyak, Bitcoin; kalender ekonomi minggu ini (dampak sedang & tinggi, waktu WIB); CNN Fear & Greed; berita ekonomi dari CNN Indonesia, CNN Business, dan Bloomberg Technoz (RSS; sumber bisa diganti lewat `MACRO_RSS`).
- **Macro Global**: berita dunia (BBC, Al Jazeera, The Guardian, NPR, DW, TechCrunch, peringatan GDACS) dikelompokkan otomatis: **🏛 Pemerintahan, 🤖 AI & teknologi, 🗳 Politik, 📢 Isu global, 🌋 Bencana alam**, dengan ringkasan jumlah per kategori. Kolom kanan: **gempa terkini BMKG** dan gempa M4,5+ seminggu terakhir dari USGS. Sumber berita bisa diganti lewat `GLOBAL_RSS`.
- Data tiap halaman di-cache beberapa menit; tombol **↻ Perbarui** mengambil ulang.

### Akun, bahasa, tema, privasi, dan install aplikasi
Tombol bulat di kanan header membuka menu akun:
- **Login (opsional)**: **Buat akun** (nama pengguna + kata sandi minimal 6 karakter). Setelah itu dashboard dan semua API meminta login. Kata sandi disimpan sebagai hash scrypt di `data/auth.json` (tidak ikut di zip), sesi berupa cookie HttpOnly 30 hari, percobaan login dibatasi 8 kali per menit. Ada **Ganti kata sandi**, **Keluar**, dan **Hapus login**. Lupa kata sandi: tutup server, hapus `data/auth.json`, jalankan lagi.
- **Bahasa**: Indonesia, English, 한국어, 日本語, Español, Русский, العربية. Menu, tombol, dan label utama diterjemahkan; isi laporan dan berita tetap dalam bahasa aslinya.
- **Tema**: 🌙 Gelap atau ☀️ Terang (chart ikut berganti).
- **👁 Sembunyikan saldo & P&L**: tombol mata di samping Financial Market (juga di menu akun) menyembunyikan Saldo IDR, Equity, Unrealized P&L, dan Total P&L, termasuk di header ringkas. Pilihan diingat browser.
- **Install aplikasi**: Veramas bisa dipasang seperti aplikasi (Chrome/Edge). Bila tombol **Install** di menu tidak memunculkan dialog, pakai menu browser → **Install Veramas** / **Apps → Install this site as an app**. Aplikasi tetap butuh server (`start.bat`) berjalan.

## Lisensi (mode LIVE)

- **Mode simulasi gratis.** Chart, bot, order simulasi, dan seluruh fitur Market Intelligence tetap bisa dipakai tanpa lisensi.
- **Mode LIVE (dana sungguhan) butuh lisensi aktif.** Menghubungkan API Indodax di mode LIVE dan order beli baru hanya diizinkan bila lisensi aktif. Order jual untuk menutup posisi selalu diizinkan, supaya posisi bisa ditutup kapan saja.
- **Aktivasi:** buka menu akun (tombol bulat di kanan header), bagian **🔑 Lisensi**, masukkan kunci `TBP-XXXX-XXXX-XXXX-XXXX`, lalu tekan **Aktifkan**. Kunci terikat ke komputer ini.
- **Pengecekan:** Veramas memeriksa lisensi ke server sekali sehari. Tekan **Cek ulang** untuk memeriksa sekarang.
- **Tanpa internet:** lisensi tetap berlaku sampai 30 hari sejak pengecekan sukses terakhir (`LICENSE_GRACE_DAYS`). Setelah itu mode LIVE dimatikan sampai terhubung lagi.
- **Pindah komputer:** kunci hanya bisa aktif di satu komputer. Minta reset ikatan ke admin, lalu aktifkan di komputer baru.
- **Pengaturan:** `LICENSE_SERVER` (alamat server lisensi) dan `LICENSE_BUY_URL` (tautan beli atau perpanjang) di `.env`.
- **Data:** ID komputer dan kunci tersimpan di `data/install.json` dan `data/license.json`. Kedua file ini ikut terbawa saat update zip, jadi jangan dihapus.

## Yang perlu diketahui

- Timeframe memakai label bahasa Inggris seperti TradingView: 1m, 15m, 30m, **1H, 2H, 4H** (jam), **1D, 3D** (hari), **1W** (minggu). 2H digabung dari candle 1H, sedangkan 3D dan 1W digabung dari candle 1D (pekan mulai Senin, hari mengikuti WIB).
- **Indodax adalah pasar spot**. Di mode LIVE bot hanya bisa beli lalu jual kembali, tanpa short. Short dan leverage hanya ada di **Futures simulasi** (lihat di atas).
- Order di Tokocrypto/Binance dan swap DEX dikirim manual dari dialog API; posisi di sana tidak dikelola bot dan tidak punya SL/TP otomatis.
- **Stop Loss dan Take Profit dijalankan oleh bot**, bukan disimpan sebagai order di Indodax. Jika komputer mati atau server ditutup, SL/TP tidak berjalan. Untuk bot 24 jam, server ini perlu dipindahkan ke VPS atau cloud.
- Order tombol Beli/Tutup memakai market order, jadi harga eksekusi bisa sedikit berbeda dari harga di layar. Biaya trading Indodax ikut dihitung.
- Data posisi dan riwayat tersimpan di folder `data/`, dan disimpan juga saat jendela server ditutup.
- Login bersifat lokal untuk komputer ini. Bila server dibuka ke jaringan lain (mis. VPS), tetap pakai HTTPS dan firewall.
- Tanda "maintenance" di daftar pasar Indodax hanya informasi. Bot tidak menolak order karenanya; di mode LIVE, Indodax sendiri yang menolak bila pasar memang dihentikan.

Bot ini alat bantu, bukan jaminan untung. Gunakan dana yang siap Anda tanggung risikonya.
