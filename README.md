# Testpoints / Pinouts Scraper

**Not:** Bu repo daha önce ximitime.com'dan Xiaomi HyperOS ROM verisi çekip
RSS feed üretiyordu (`fetch_roms.js`, `index.js`, `feed/roms_*.json`,
`feed/rss_*.xml`). O sistem tamamen kaldırıldı — artık repo üç kaynağı
çekiyor: sigmakey.com'un Testpoints/Pinouts arşivi (konu adı + görsel
linki, bu dosyada anlatılıyor), miuirom.org'un EDL Point arşivi
(`README_edlpoint.md`) ve device-forum.com'un tüm medya galerisi
(`README_deviceforum.md`).

## Ne yapıyor

`fetch_testpoints.js`, https://sigmakey.com/en/sigma-help/testpoints-pinouts/
adresindeki tüm marka ve platform (Exynos, MTK, Qualcomm, ADB Mode,
HiSilicon...) sekmelerini gerçek bir headless tarayıcıyla (Puppeteer) açıp
aşağı kaydırarak (sayfa "infinite scroll" ile yüklendiği için düz HTTP
isteği yeterli değil) her testpoint kartının:

- **konu adı** (örn. `Huawei, ADB Mode, ABR-AL00`)
- **görsel linki** (tam boy testpoint görselinin URL'i)

bilgisini toplar.

## Kurulum

```bash
npm install
```

## Kullanım

```bash
# Tüm markaları çek
npm run scrape

# Görselleri de indir (feed/testpoints/images/*.jpg)
npm run scrape:images

# Sadece belirli markalar
node fetch_testpoints.js --brands Huawei,Samsung,Motorola,Vivo --out-dir ./feed
```

## Çıktı

```
feed/
  testpoints_all.json          # tüm markalar, tek liste
  testpoints_coverage.json     # her marka için toplanan/badge sayısı karşılaştırması
  testpoints/
    Huawei.json
    Samsung.json
    ...
    images/                    # sadece --download-images ile
```

Her kayıt:

```json
{
  "brand": "Huawei",
  "platform": "ADB Mode",
  "title": "Huawei, ADB Mode, ABR-AL00",
  "image_url": "https://sigmakey.com/content/nfs/testpoints/....jpg"
}
```

## GitHub Actions

`.github/workflows/scrape.yml` günde bir kez (veya manuel tetiklemeyle)
`fetch_testpoints.js`, `fetch_edlpoint.js` ve `fetch_deviceforum.js`'i
sırayla çalıştırıp `feed/` klasörünü commit'ler ve GitHub Pages'e yayınlar.
Marka/kategori sayısı fazla olduğundan (Huawei tek başına ~968 kayıt,
device-forum.com toplamda 7.000+ görsel), ilk birkaç çalıştırmayı Actions
loglarından izleyip `testpoints_coverage.json` / `deviceforum_coverage.json`
çıktılarında eksik var mı kontrol etmeniz önerilir.

**Görseller nereden yayınlanır?** Workflow, deponun adına bakarak Pages
adresini (`https://<owner>.github.io/<repo>`) otomatik hesaplıyor ve üç
scraper'a da `--download-images --base-url ...` ile veriyor — yani üretilen
RSS feed'lerindeki görseller hedef sitelerin (sigmakey.com / miuirom.org /
device-forum.com) linkleri değil, **bu reponun GitHub Pages'inde barınan
kopyalar**dır. Detaylar için `README_testpoints.md`, `README_edlpoint.md` ve
`README_deviceforum.md` dosyalarına bakın.
