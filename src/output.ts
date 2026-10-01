import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Dosya bu boyutu geçince boşaltılır; okuyan taraf kendi kopyasını zaten tutuyor. */
const MAX_BYTES = 1024 * 1024;

/**
 * Bir koşunun paylaşılan çıktı dosyası, kayıt klasörüne göre: `output/<windowId>/<anahtar>-<başlangıç>.log`.
 * Her koşu yeni bir dosya alır; okuyan taraf yeni adı görünce baştan okur.
 */
export function outputPath(windowId: string, folderPath: string, startedAt: number): string {
    const key = crypto.createHash('sha1').update(folderPath).digest('hex').slice(0, 16);

    return path.posix.join('output', windowId, `${key}-${startedAt.toString(36)}.log`);
}

/**
 * Sunucu çıktısını paylaşılan bir dosyaya da yazar; Pitwall uygulaması sunucu bu pencerede
 * koşarken çıktıyı buradan izler. 1 MB'ı geçen dosya boşaltılır, okuyan dosya küçülünce
 * baştan okur. Koşu bitince dosya silinir.
 */
export class OutputMirror {
    private bytes = 0;

    public constructor(private readonly file: string) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '');
        } catch {
        }
    }

    public append(text: string): void {
        const size = Buffer.byteLength(text);
        const flag = this.bytes + size > MAX_BYTES ? 'w' : 'a';

        this.bytes = flag === 'w' ? size : this.bytes + size;

        try {
            fs.writeFileSync(this.file, text, { flag });
        } catch {
        }
    }

    public remove(): void {
        try {
            fs.unlinkSync(this.file);
        } catch {
        }
    }
}
