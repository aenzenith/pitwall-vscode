import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Eklentinin Marketplace'te silinmeden önceki kimliği; eski depolama klasörü bu adı taşır. */
export const OLD_EXTENSION_ID = 'aenzenith.pitwall';

/**
 * Pencereler arası ortak kayıt. VS Code'un kendi depolama klasörü yerine burada durur ki
 * Pitwall masaüstü uygulaması, Cursor ve VS Code Insiders da aynı kaydı görsün.
 */
export function sharedDir(): string {
    return path.join(os.homedir(), '.pitwall');
}

/**
 * Favoriler ve Claude "görüldü" kayıtları eski klasörlerden bir kez taşınır: hedefte dosya
 * yoksa, listede ilk bulunan kaynaktan kopyalanır. Hedefteki dosyaya hiç dokunulmaz.
 * Pencere ve pid kayıtları geçicidir, taşınmaz.
 */
export function adoptOldStorage(targetDir: string, sourceDirs: readonly string[]): void {
    for (const file of ['favorites.json', 'claude-seen.json']) {
        const to = path.join(targetDir, file);

        try {
            if (fs.existsSync(to)) {
                continue;
            }

            const from = sourceDirs.map((dir) => path.join(dir, file)).find((candidate) => fs.existsSync(candidate));

            if (from) {
                fs.mkdirSync(targetDir, { recursive: true });
                fs.copyFileSync(from, to);
            }
        } catch {
        }
    }
}

/**
 * Dosyayı önce geçici adla yazıp sonra yerine taşır. Kaydı başka süreçler de okuduğu için
 * yarım yazılmış bir dosya hiç görünmez. Geçici ad `.json` ile bitmez; okuyucular onu atlar.
 */
export function writeAtomic(file: string, content: string): void {
    const temp = `${file}.${process.pid}.tmp`;

    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
}
