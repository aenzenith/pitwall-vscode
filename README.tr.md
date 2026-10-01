# Pitwall

Proje pencereleri arasında geç, npm dev sunucularını çalıştır — bütün açık VS Code
pencereleri tek panelde.

*[English](README.md)*

```
┌─ NPM DEV ──────────────── 3 çalışıyor ─┐
│ Bu pencere                             │
│  ● paddock                             │
│ Favoriler                              │
│  ● telemetry-api 🔸                    │
│  ⊘ garage-admin                        │
│  ○ pitlane-docs                        │
│  ⊘ apex-cms                            │
│ Başka pencereler                       │
│  ● gridwall.dev                        │
└────────────────────────────────────────┘
```

Durum ikonda: `●` çalışıyor · `○` durdu · `⊘` penceresi kapalı favori. Satırda yalnız
klasör adı yazar; pencere adı ancak klasör adından farklıysa eklenir. Adın yanındaki küçük
`🔸`, Claude'un orada seni beklediğini gösterir.

## Panel

- **Bu pencere** — workspace'in kök klasörleri.
- **Favoriler** — ★ işaretlediklerin. Penceresi kapalıyken de listede durur; başlatırsan
  bu pencerenin terminalinde çalışır.
- **Başka pencereler** — o an açık diğer VSCode pencerelerinin projeleri. Oradaki sunucu
  buradan durdurulur/başlatılır; `↗` ile o pencereye geçilir.

Pencereler ortak bir dizin üzerinden haberleşir (eklentinin globalStorage'ı): her pencere
5 sn'de bir durumunu ve kök klasörlerini yazar, iş emirleri dosya olarak bırakılır. 20 sn ses
çıkarmayan pencere listeden düşer. Bir projeyi yalnız kökünde tutan ya da orada çalıştıran
pencere sahiplenir; favoriler ortak listedir, kimsenin penceresine yazılmaz.

## Claude oturumları

Birçok projede Claude'a iş verip başka işe geçersin; sonuç geldi mi diye bakmayı unutmamak
için. Pitwall paneldeki her projenin Claude Code oturum kayıtlarını (`~/.claude/projects`)
okur — CLI ve VS Code oturumları, alt klasörde açılanlar dahil.

- **Adın yanında `🔸`** — Claude turu bitirdi ya da soru sordu (`AskUserQuestion`, plan
  onayı) ve henüz bakmadın. Hangisi olduğu ve saati tooltip'te yazar. Claude hâlâ
  çalışıyorsa işaret yok.
- **Silinir**: o projenin penceresi odak alınca, ya da satıra veya rozete tıklayınca.
  Baktığın pencerede biten iş hiç işaretlenmez.
- **Durum çubuğunda `🔸 2`** — bekleyen proje sayısı. Tıklayınca projeye gider; birden
  fazlaysa hangisi diye sorar.
- Penceresi kapalı favorilerde de çalışır. "Görüldü" bilgisi bütün pencerelerde ortaktır;
  özelliğin ilk açılışından eski işler görülmüş sayılır.

Yakalanmayan: izin istemleri (Claude Code bunları kayda yazmıyor). Kayıt formatı resmi bir
API değil; bir Claude Code güncellemesi algılamayı bozabilir.

## Özellikler

- **Start / stop / reload** — satır içi düğmeler ya da durum çubuğu (`⌘⌥D`, `⌘⌥R`).
- **Panel başlığı üç düğme** — `▷` listedeki durmuş her projeyi başlatır, `■` çalışan her
  projeyi durdurur, `⟳` çalışanların hepsini yeniden başlatır. Üçü de bütün pencereleri
  kapsar; başka pencerenin projesi için iş emri o pencereye gider. Aralarında 1 sn bekleme
  var, portlar yarışmasın.
- **Çalışan sayısı** — durum çubuğunda `▶ 3` (bütün pencereler toplamı), grup başlığında
  `3 çalışıyor`. Hiçbiri çalışmıyorsa rozet görünmez.
- **Boş port garantisi — sessiz.** Başlamadan önce hedef port yoklanır; doluysa üstündeki ilk
  boş porta geçilir (`npm run dev -- --port 5176`). Uyarı yok, satırda işaret yok, soru yok.
  Hedef port: `pitwall.port` → `vite.config` içindeki `server.port` → 5173. Aynı anda birden
  çok sunucu kalkarken dağıtılan portlar 60 sn boyunca rezerve tutulur — sunucu henüz dinlemeye
  başlamadığı için ikinci sunucuya aynı port verilmez. Yine de `EADDRINUSE` gelirse proje başına
  bir kez sessizce boş porta taşınır.
- **Otomatik başlat** — pencere açılınca. `pitwall.autoStart`: `lastSession` (varsayılan),
  `favorites`, `workspace`, `off`. Aynı projeyi başka pencere çalıştırıyorsa atlanır;
  başlatmalar arasında 1,5 sn bekleme var.
- **Adres düğmesi** — çalışan satırdaki `↗` tarayıcıda açar. Sıra kesin: `pitwall.url` →
  `.env` içindeki `APP_URL` → Laravel projesinde `https://<klasör>.test` → **son çare**
  sunucunun bastığı adres. Vite adresi uygulamanın adresi değildir, ona düşülmez.
  Kendiliğinden açılmaz; isteyen `pitwall.openUrlOnStart` ile açar.
- **Satıra tıklamak** projenin penceresine götürür (dev çalışsın çalışmasın): pencere açıksa
  öne gelir, kapalıysa proje **yeni pencerede** açılır — bu pencerenin üstüne açılmaz.
  Başlatan tek şey `▶` düğmesi.
- **Terminal sekmesi açılmaz.** Sunucular arka plan süreci olarak koşar; çıktı proje başına
  bir Output kanalına (`Dev: paddock`) yazılır, satırdaki `⎙` düğmesiyle açılır. Süreçler
  kendi süreç grubunda başlar, durdurulurken `npm`'in altındaki `vite` de kapanır.
  Pencere kapanınca hepsi öldürülür — öksüz sunucu kalmaz.
- **Çökme algısı ve otomatik yeniden başlatma** — süreç kendi kendine düşerse (çıkış kodu
  fark etmez, bilerek durdurma sayılmaz) satır kırmızıya döner ve sunucu 3 sn sonra geri
  kaldırılır. Kaç kez çökerse çöksün geri gelir; yalnız art arda üç yeniden başlatma 60 sn
  içinde ölürse vazgeçilir (`çöktü — … · 3 denemeden sonra vazgeçildi`). Elle başlatmak
  sayacı sıfırlar.
- **Sağlık yoklaması** — her 30 sn'de çalışan her sunucunun portu yoklanır (IPv4 ve IPv6
  loopback). Süreç ayakta ama port cevap vermiyorsa satır sarıya döner (`:5173 yanıt
  vermiyor`); 3 sn sonra hâlâ sessizse süreç öldürülüp yeniden başlatılır, aynı üç deneme
  kuralıyla.
- **Hata satırı satırda** — çıktıda `Failed to resolve`, `Cannot find module`, `SyntaxError`,
  `npm ERR!` gibi bir satır görülürse satırın yanına kısaltılıp yazılır; çıktıya `⎙` düğmesiyle gidilir.
- **Öksüz süreç temizliği** — eklenti çökerse `deactivate` koşmaz. Her pencere pid'lerini
  ortak `pids/` dizinine yazar; sonraki açılışta ölü pencerelerin bıraktığı süreç grupları
  kapatılır.
- **`build` script'leri çalıştırılmaz** — açık dev sunucusunu bozduğu için bilerek engelli.
- Paket yöneticisi lock dosyasından bulunur (pnpm / yarn / bun / npm).
- **Türkçe ve İngilizce** — arayüz VS Code'un görüntü diline uyar.

## Ayarlar

| Anahtar | Varsayılan |
|---|---|
| `pitwall.script` | `dev` |
| `pitwall.packageManager` | `auto` |
| `pitwall.port` | `0` (otomatik) |
| `pitwall.autoStart` | `lastSession` |
| `pitwall.autoStartOpensUrl` | `false` |
| `pitwall.openUrlOnStart` | `false` |
| `pitwall.url` | `""` (otomatik) |
| `pitwall.openUrlTimeoutMs` | `15000` |
| `pitwall.revealTerminal` | `false` (çıktı kanalını öne getir) |
| `pitwall.restartDelayMs` | `600` |

## Geliştirme

```bash
npm install
npm test        # saf mantık testleri (vitest)
npm run compile
```

VSCode'da bu klasörü aç, **F5** — Extension Development Host açılır.

## Kurulum

```bash
npm run package
code --install-extension pitwall-0.7.1.vsix
```

## Lisans

MIT
