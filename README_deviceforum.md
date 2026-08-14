# Device Forum Media Gallery Scraper (device-forum.com)

## Ne yapıyor

`fetch_deviceforum.js`, https://device-forum.com/media/ adresindeki tüm
medya galerisini (schematics, testpoint, pinout, board fotoğrafları vb.)
çeker. Bu XenForo forumundaki galeri sayfası da (fetch_edlpoint.js'in
çektiği miuirom.org sayfası gibi) **tamamen sunucu tarafında** render
ediliyor — sonsuz kaydırma yok, düz sayfalama var
(`/media/`, `/media/page-2`, `/media/page-3`, ... son sayfaya kadar).
Bu yüzden burada da Puppeteer'e gerek yok, düz `https` isteği + cheerio
yeterli.

Sitede şu an ~565 kategori (marka > model serisi > tam model, örn.
Samsung > SM-G > SM-G991) ve 7.000'den fazla yüklenmiş görsel var,
~140+ liste sayfasına yayılmış (sayfa başına 50 öğe).

**Önemli verimlilik notu:** diğer iki scriptin aksine, her öğe için ayrı
bir detay-sayfası isteği ATMIYORUZ. Tam boy görsel her zaman
`https://device-forum.com/media/<id>/full` adresinde — bu, öğenin liste
sayfasındaki linkinden (`/media/<id>/`) doğrudan türetilebiliyor. Yani
tüm siteyi taramak için gereken istek sayısı ≈ liste sayfası sayısı
(~140+), öğe sayısı (~7.000+) değil.

Her öğe için toplanan alanlar: `id`, `title` (bu sitede başlık genelde
orijinal dosya adının kendisi, örn. `SAMSUNG SM-G991 TOUCHSCREEN.webp`),
`category_id`/`category_name` (kart üzerinde görünen kategori, örn.
`SM-G991`), `page_url`, `thumbnail_url`, `image_url` (tam boy),
`added_by`, `date_added`, `view_count`, `comment_count` (son dördü
"best effort" — kart üzerinde bulunamazsa `null`).

## Kurulum

```bash
npm install
```

## Kullanım

```bash
# TÜM galeriyi çek (tüm kategoriler, tüm sayfalar, sınırsız)
npm run scrape:deviceforum

# Görselleri de indir (feed/deviceforum/images/*)
npm run scrape:deviceforum:images

# Test/deneme için sadece ilk 5 sayfa
node fetch_deviceforum.js --out-dir ./feed --max-pages 5

# Kesilen bir taramaya kaldığı yerden devam et
node fetch_deviceforum.js --out-dir ./feed --start-page 42

# Sadece tek bir kategori (örn. SM-G991, id=563)
node fetch_deviceforum.js --out-dir ./feed --category 563

# GitHub Pages'ten yayınla: RSS, device-forum.com yerine BU reponun
# Pages adresindeki görsele link versin
node fetch_deviceforum.js --out-dir ./feed --download-images \
  --base-url https://<kullanici>.github.io/<repo>
```

## Görselleri GitHub Pages'ten yayınlamak

Diğer iki scriptle birebir aynı mekanizma: `--download-images` +
`--base-url` birlikte verilirse görsel önce `feed/deviceforum/images/`
altına indirilir (id ile eşsizleştirilmiş dosya adıyla,
`<id>_<orijinal dosya adı>`), sonra RSS'teki her item GitHub Pages
linkine işaret eder; `deviceforum_all.json`'da hem orijinal `image_url`
hem de `published_image_url` ayrı ayrı tutulur.
`.github/workflows/scrape.yml` bunu otomatik hesaplıyor.

## Görsel indirmede tekrar-önleme (dedup)

`deviceforum/images-manifest.json`, hangi id'nin zaten indirildiğini
tutar. Bir sonraki çalıştırmada zaten indirilmiş ve diskte hâlâ duran
dosyalar TEKRAR indirilmez — sadece yeni eklenen görseller için istek
atılır. Galeri her gün büyüdüğü için bu, günlük cron çalıştırmalarını
pratik hâle getiren şey.

## Çıktı

```
feed/
  deviceforum_all.json          # tüm öğeler, tek liste
  deviceforum_categories.json   # category_id -> {name, url}, taranan sayfalardan toplanan
  deviceforum_coverage.json     # kaç sayfa tarandı / sitenin bildirdiği toplam sayfa
  deviceforum/
    images/                     # sadece --download-images ile
    images-manifest.json
  rss_deviceforum.xml           # RSS feed: her item = 1 görsel, TÜM öğeler (sınırsız)
```

## Büyük bir tarama — nazik davranıyoruz

Şu an ~140+ liste sayfası ve 7.000+ görsel (7.8 GB) var. Her istek
arasında kısa bir bekleme var (`--delay`, varsayılan 200ms). Tam
kapsamlı bir `--download-images` çalışması uzun sürer ve çok
bant genişliği/disk kullanır — "gerçekten her şeyi indir" istendiği
için bu beklenen bir durum, hata değil. Test ederken `--max-pages`
kullanın.

## Ayrıştırma mantığı / kırılganlık notu

Belirli bir CSS class adına güvenmek yerine (add-on'un markup'ı
haber verilmeden değişebilir), script şu genel yaklaşımı kullanıyor:

1. `src`'i `/xfmg/thumbnail/` içeren her küçük resmi (`<img>`) bulur.
2. Bu resmin ebeveynlerine (en fazla 8 seviye) tırmanır, metni
   "View count" içeren düğüme ulaşana kadar — bu, tüm kartın sınırıdır.
3. Kart içinde: id'yi thumbnail linkinden, başlığı aynı id'ye giden
   diğer linkten (yoksa resmin `alt` özniteliğinden), kategoriyi
   `/media/categories/<id>/` linkinden, geri kalanını kartın düz
   metni üzerinde basit regex ile çıkarır.

Bu 0 öğe döndürürse (konsolda uyarı basılır), sitenin markup'ı
değişmiş olabilir — `fetch_deviceforum.js` içindeki
`parseListingPage()` fonksiyonunu güncel HTML'e göre gözden geçirin.

## GitHub Actions

`.github/workflows/scrape.yml`'e üçüncü bir adım olarak zaten eklendi;
diğer iki scriptle aynı günlük cron job'da, aynı `--base-url` hesaplama
mantığıyla çalışıyor.
