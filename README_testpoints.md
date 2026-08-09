# Testpoints / Pinouts Scraper (sigmakey.com)

## Neden Puppeteer?

`fetch_roms.js` düz `https` isteğiyle çalışıyor çünkü ximitime.com tüm veriyi
sunucu tarafında (SSR) veriyor. sigmakey.com'un Testpoints/Pinouts sayfası
farklı: nav'daki sayaç ("Motorola (14)") ile ilk yüklemede dönen HTML'deki
gerçek kart sayısı (9) tutmuyor — geri kalan kayıtlar sayfa aşağı kaydırıldıkça
(infinite scroll) JS ile ekleniyor. Bu yüzden düz `fetch()`/`https.get()` ile
arşivin tamamını çekemiyoruz; gerçek bir tarayıcı sekmesiyle sayfayı kaydırıp
DOM'u öyle okumak gerekiyor. `fetch_testpoints.js` bunu Puppeteer (headless
Chromium) ile yapıyor.

## Kurulum

```bash
npm install puppeteer
```

GitHub Actions'ta (ubuntu-latest) Puppeteer kendi Chromium'unu indirir,
ekstra apt paketi genelde gerekmez; sorun çıkarsa şu adımı ekleyin:

```yaml
- name: Install Chrome deps
  run: npx puppeteer browsers install chrome
```

## Kullanım

```bash
# Tüm markaları çek (konu adı + görsel linki), feed/ altına yaz
node fetch_testpoints.js --out-dir ./feed

# Sadece belirli markalar
node fetch_testpoints.js --brands Huawei,Samsung,Motorola,Vivo --out-dir ./feed

# Görselleri de indir (feed/testpoints/images/*.jpg)
node fetch_testpoints.js --out-dir ./feed --download-images
```

## Çıktı

```
feed/
  testpoints_all.json          # tüm markalar, tek liste: {brand, platform, title, image_url}
  testpoints/
    Huawei.json
    Samsung.json
    Motorola.json
    ...
    images/                    # sadece --download-images ile
      Huawei_Huawei, ADB Mode, ABR-AL00.jpg
      ...
```

Her kayıt:

```json
{
  "brand": "Huawei",
  "platform": "ADB Mode",
  "title": "Huawei, ADB Mode, ABR-AL00",
  "image_url": "https://sigmakey.com/content/nfs/testpoints/TESTPOINT%20HUAWEI%20P50_ABR-LX9-1753699792.jpg"
}
```

## GitHub Actions'a eklemek için

Mevcut `.github/workflows/scrape.yml`'e benzer şekilde ayrı bir job/workflow
olarak ekleyebilirsiniz (marka sayısı ~160+ olduğundan tüm taramayı `--brands`
ile parçalara bölüp cron'a yaymak, tek seferde 35 dk timeout'u aşmamak için
mantıklı olur).

## Notlar / Sınırlamalar

- Sayfa her ana markanın altında platform sekmeleri (Exynos / MTK / Qualcomm /
  ADB Mode / HiSilicon vb.) barındırıyor; script her sekmeyi ayrı ayrı
  kaydırıp topluyor, böylece "birleşik" görünümdeki gizli/kesilmiş liste
  sorununu bypass ediyor.
- `--download-images` gerçek jpg/png dosyalarını da indirir; arşiv büyük
  olduğundan (Huawei tek başına ~968 kayıt) disk/bant genişliği ayırın.
- Script kibarlığı için scroll/tıklama arasında ~900ms bekliyor; siteyi
  yormamak adına bunu düşürmeyin.
