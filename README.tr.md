# Pitwall

*Açık her VS Code penceresi, dev sunucusu ve Claude oturumu — tek panelde.*

*[English](README.md)*

<img src="media/panel-dark.png" width="380" alt="Pitwall paneli">

## Özellikler

- **Bütün projeler tek listede** — bu pencerenin klasörleri, favorilerin ve açık diğer VS Code pencerelerinin projeleri. Favoriler pencereleri kapalıyken de listede kalır; başlatırsan buradan çalışır.
- **Pencereler arası geçiş** — satıra tıkla, o pencere öne gelsin. Hiçbir yerde açık olmayan proje yeni pencerede açılır. Tıklamak sunucu başlatmaz — bunu yalnız `▶` yapar.
- **Terminal sekmesi olmadan dev sunucusu** — `npm run dev`'i satırdan, panel başlığından ya da durum çubuğundan başlat, durdur, yeniden başlat. Çıktı proje başına bir Output kanalına yazılır.
- **Çalışan sayısı** — durum çubuğunda bütün pencerelerin toplamı `▶ 3`, her grup başlığında `3 çalışıyor`.
- **Claude bitirdiğinde haberin olsun** — küçük turuncu nokta, başka bir projede Claude'un işi bitirdiğini ya da sana soru sorduğunu gösterir. [Ayrıntılar aşağıda](#claude-oturumları).
- **Port kavgası yok** — port doluysa sıradaki boş port kullanılır. Soru sorulmaz.
- **Kendini toparlayan sunucular** — çöken ya da yanıt vermeyen sunucu 3 sn sonra geri kalkar. Art arda üç başarısız denemeden sonra Pitwall vazgeçer.
- **Hata satırda** — `Cannot find module`, `npm ERR!` gibi satırlar proje adının yanında görünür.
- **Vite portunu değil, uygulamanı açar** — `↗`, `.env` içindeki `APP_URL`'i ya da Laravel projesinde `https://<klasör>.test` adresini açar.
- **Otomatik başlat** — pencere açılınca çalışanları geri kaldırır; ya da favorileri, ya da bütün kök klasörleri.
- **Öksüz süreç kalmaz** — pencere kapanınca sunucuları durur; çöken pencereden kalanlar bir sonraki açılışta temizlenir.
- **`build` asla çalışmaz** — production build açık dev sunucusunu bozar.
- macOS, Linux ve Windows. Türkçe ve İngilizce.

### Durum ikonları

| İkon | Anlamı |
|---|---|
| `●` | Çalışıyor |
| `○` | Durdu |
| `⊘` | Penceresi kapalı favori |
| `⚠` | Port yanıt vermiyor |
| `✕` | Çöktü |
| ikonda turuncu `•` | Claude seni bekliyor |

Satırda klasör adı yazar; pencere adı yalnız farklıysa eklenir.

## Claude oturumları

Birçok projede Claude'a iş ver, başka işe geç, dönmeyi unutma.

- **Turuncu nokta**, bakmadığın bir pencerede Claude turu bitirince ya da soru sorunca (`AskUserQuestion`, plan onayı) çıkar. Hangisi olduğu ve saati tooltip'te yazar.
- **Alt ajanlar çalışırken çıkmaz:** arka planda ajan bırakarak biten tur henüz bitmiş sayılmaz. Nokta, ajanlar bitip Claude işi toparlayınca çıkar.
- **Silinir**: o pencereye geçince ya da satıra tıklayınca.
- **Durum çubuğu** bekleyen proje sayısını gösterir (`• 2`). Tıklayınca birine gider.
- CLI ve VS Code oturumlarını, alt klasörde açılan oturumları ve penceresi kapalı favorileri kapsar.

Yakalanmayan: izin istemleri — Claude Code bunları kayda yazmıyor. Kayıt formatı resmi bir API değil; bir Claude Code güncellemesi algılamayı bozabilir.

> **Gizlilik:** Pitwall, Claude Code oturum kayıtlarının (`~/.claude/projects`) yalnız son satırlarını ve çalışan oturumlarının durumunu (`~/.claude/sessions`: süreç kimliği, oturum kimliği ve durum, başka hiçbir şey) yalnız senin makinende okur. Hiçbir yere bir şey gönderilmez, `~/.claude` içinde hiçbir şey değiştirilmez.

## Komutlar

| Komut | Kısayol |
|---|---|
| npm dev başlat/durdur | `⌘⌥D` · `Ctrl+Alt+D` |
| npm dev yeniden başlat | `⌘⌥R` · `Ctrl+Alt+R` |
| Listedeki hepsini başlat | |
| Listedeki hepsini durdur | |
| Çalışanların hepsini yeniden başlat | |
| Favorilere klasör ekle | |
| Claude'un beklediği projeleri göster | |

Toplu komutlar bütün pencereleri kapsar; başka pencerenin projesi için iş o pencereye devredilir.

## Ayarlar

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `pitwall.script` | `dev` | Çalıştırılacak npm script'i. `build` ile başlayanlar reddedilir. |
| `pitwall.packageManager` | `auto` | `npm`, `pnpm`, `yarn` ya da `bun`. `auto` lock dosyasına bakar. |
| `pitwall.port` | `0` | Kullanılacak port. `0` = `vite.config` içindeki `server.port`, yoksa 5173. |
| `pitwall.autoStart` | `lastSession` | Pencere açılınca ne başlasın: `lastSession`, `favorites`, `workspace` ya da `off`. |
| `pitwall.autoStartOpensUrl` | `false` | Otomatik başlatma da tarayıcı açsın. |
| `pitwall.openUrlOnStart` | `false` | Sunucuyu başlatınca tarayıcıyı aç. |
| `pitwall.url` | `""` | Açılacak sabit adres. Boşsa `APP_URL`, sonra `<klasör>.test`, sonra sunucunun adresi. |
| `pitwall.openUrlTimeoutMs` | `15000` | Sunucu adres basmazsa bu süre sonunda bilinen adres açılır. |
| `pitwall.revealTerminal` | `false` | Başlatınca çıktı kanalını öne getir. |
| `pitwall.restartDelayMs` | `600` | Durdurma sinyali ile zorla kapatma arasındaki bekleme. |

Çok köklü workspace'te her ayar klasör başına ayrı verilebilir.

## Nasıl çalışır

- **Pencereler durumu** `~/.pitwall/` üzerinden paylaşır; VS Code, Cursor, VS Code Insiders ve Pitwall masaüstü uygulaması aynı klasörü okur. Her pencere 5 sn'de bir projelerini yazar; 20 sn ses vermeyen pencere listeden düşer.
- **Toplu ve otomatik başlatmalar** arasında 1 sn ve 1,5 sn bekleme var, portlar yarışmasın; başka pencerede çalışan proje atlanır.
- **Dağıtılan portlar** 60 sn tutulur; aynı anda kalkan iki sunucuya aynı port verilmez. `EADDRINUSE` gelirse proje bir kez boş porta taşınır.
- **Sağlık yoklaması** her 30 sn'de çalışan sunucunun portuna IPv4 ve IPv6'dan bakar. 3 sn sonra hâlâ sessizse yeniden başlatılır.
- **Durdurma** bütün süreç ağacını kapatır, `npm` altındaki `vite` de gider: macOS ve Linux'ta süreç grubu, Windows'ta `taskkill /T`.
- **Öksüz temizliği** — her pencere pid'lerini kaydeder. pid'leri çabuk yeniden kullanan Windows'ta artık pid yalnız hâlâ `cmd.exe`'ye aitse kapatılır.
- **Claude "görüldü" bilgisi**, `~/.pitwall/` içinde proje başına bir zamandır ve bütün pencerelerde ortaktır. İlk açılıştan eski işler görülmüş sayılır.

## Kurulum

VS Code Marketplace'ten ya da [releases](https://github.com/aenzenith/pitwall-vscode/releases) sayfasındaki `.vsix` ile:

```bash
code --install-extension pitwall-vscode-<sürüm>.vsix
```

## Geliştirme

```bash
npm install
npm run typecheck
npm test
```

VS Code'da **F5** ile Extension Development Host açılır. CI Linux, macOS ve Windows'ta koşar. Sürümleri [release-please](https://github.com/googleapis/release-please) Conventional Commits'ten çıkarır.

## Lisans

MIT
