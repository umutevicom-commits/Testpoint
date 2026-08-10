# EDL Point Scraper (miuirom.org)

## Ne yapıyor

`fetch_edlpoint.js`, https://miuirom.org/updates/edl-point sayfasındaki
Xiaomi / REDMI / POCO cihazlarının EDL (Emergency Download) test point
görsellerini çeker. Bu sayfa `fetch_testpoints.js`'in çektiği sigmakey.com
sayfasının aksine **tamamen sunucu tarafında (SSR)** render ediliyor — sonsuz
kaydırma veya "load more" yok, tüm cihazlar tek seferde HTML içinde geliyor.
Bu yüzden Puppeteer yerine düz `https` isteği + HTML ayrıştırma (cheerio)
yeterli — `fetch_roms.js`'in kullandığı yaklaşımın aynısı.

Sayfada her cihaz için küçük bir küçük resim (thumbnail) var; tıklanınca
popup'ta tam boy test point fotoğrafı açılıyor:

```
küçük resim : https://miuirom.org/wp-content/uploads/test-point/mi-redmi-7a-edl-point-250x148.jpg
tam boy (popup) : https://miuirom.org/wp-content/uploads/test-point/mi-redmi-7a-edl-point.jpg
```

Script her cihaz için popup'ta açılan **tam boy görsel linkini** ve **konu
başlığını** (cihaz adı, örn. `REDMI 7A`) toplar; ayrıca bölüm (Xiaomi /
REDMI / POCO), codename ve model numaraları da kaydedilir.

## Kurulum

```bash
npm install
```

## Kullanım

```bash
# Tüm cihazları çek
npm run scrape:edlpoint

# Görselleri de indir (feed/edlpoint/images/*.jpg)
npm run scrape:edlpoint:images

# Sadece belirli bölümler
node fetch_edlpoint.js --sections Xiaomi,POCO --out-dir ./feed

# GitHub Pages'ten yayınla: RSS, miuirom.org yerine BU reponun Pages
# adresindeki görsele link versin
node fetch_edlpoint.js --out-dir ./feed --download-images \
  --base-url https://<kullanici>.github.io/<repo>
```

## Görselleri GitHub Pages'ten yayınlamak (hedef siteye değil)

Varsayılan olarak RSS'teki `<link>`/`<enclosure>` miuirom.org'daki orijinal
görsele işaret eder. Bunun yerine **bu repodaki GitHub Pages'te barınan
kopyaya** işaret etmesini istiyorsanız, hem `--download-images` hem de
`--base-url` bayraklarını birlikte verin:

```bash
node fetch_edlpoint.js --out-dir ./feed --download-images \
  --base-url https://<kullanici>.github.io/<repo>
```

Bu durumda:
- Görsel önce `feed/edlpoint/images/` altına indirilir (daha önce indirilmişse tekrar indirilmez),
- RSS'teki her item artık şuna benzer bir linke sahip olur:
  `https://<kullanici>.github.io/<repo>/feed/edlpoint/images/mi-redmi-7a-edl-point.jpg`
  (miuirom.org linki **değil**),
- `edlpoint_all.json` içinde her kayıtta hem orijinal `image_url` (kaynak,
  indirme/dedup için) hem de RSS'te kullanılan `published_image_url` (GitHub
  Pages linki) ayrı ayrı tutulur.

`.github/workflows/scrape.yml` her çalıştığında `--base-url`'i deponun adına
göre otomatik hesaplıyor (`https://<owner>.github.io/<repo>`), yani GitHub
Actions üzerinden çalıştırdığınızda elle bir şey girmenize gerek yok. Sadece
`--base-url` verip `--download-images` vermezseniz script bunu fark edip
uyarı basar ve o item için orijinal miuirom.org linkine geri döner.

## Çıktı

```
feed/
  edlpoint_all.json          # tüm cihazlar, tek liste
  edlpoint/
    Xiaomi.json
    REDMI.json
    POCO.json
    images/                  # sadece --download-images ile
    images-manifest.json
  rss_edlpoint.xml           # RSS feed: her item = 1 cihaz, görsel + başlık
```

Her kayıt:

```json
{
  "section": "REDMI",
  "title": "REDMI 7A",
  "codename": "pine",
  "models": "M1903C3EG, M1903C3EH, M1903C3EI, M1903C3EE, M1903C3ET, M1903C3EC",
  "image_url": "https://miuirom.org/wp-content/uploads/test-point/mi-redmi-7a-edl-point.jpg",
  "thumbnail_url": "https://miuirom.org/wp-content/uploads/test-point/mi-redmi-7a-edl-point-250x148.jpg",
  "phone_url": "https://miuirom.org/phones/redmi-7a"
}
```

RSS item başlığı `"<title> EDL Point"` şeklinde (örn. `REDMI 7A EDL Point`),
`<link>`/`<enclosure>` tam boy görsel URL'ini gösterir.

## Ayrıştırma mantığı / kırılganlık notu

`fetch_testpoints.js`'deki gibi belirli bir CSS class'ına (Elementor/tema
markup'ı önceden bilinmediği ve değişebileceği için) güvenmek yerine, script
sayfayı **doküman sırasına göre düz bir token listesine** çeviriyor
(`linearize()`), sadece şu iki sabit gerçeğe dayanarak:

- tam boy görsel linki her zaman `/wp-content/uploads/test-point/...jpg`
  içerir,
- cihaz adı linki her zaman `/phones/<slug>` içerir.

Her görsel token'ından sonra gelen ilk `phone` linki cihaz adı+linki, ondan
sonraki en fazla 2 düz metin satırı da codename + model numaraları olarak
alınıyor (sayfada gözlemlenen sabit şablon budur). Bu, sonraki
paragraflar/yorumlar bölümünün yanlışlıkla son cihaza eklenmesini önlüyor.

Site markup'ı değişirse (`items.length` çıktısı 0 veya beklenenden çok
düşük gelirse), `fetch_edlpoint.js` içindeki `linearize()` / `parseEdlPoints()`
fonksiyonlarını güncel HTML'e göre gözden geçirin — script 0 sonuç dönerse
konsola uyarı basıyor.

## GitHub Actions

Mevcut `.github/workflows/scrape.yml`'e benzer ayrı bir job/workflow olarak
eklenebilir; tek sayfa olduğu için (Puppeteer yok) çalışma süresi çok kısa
olacaktır — sigmakey.com işi gibi uzun timeout gerekmez.
