import * as fs from 'fs';
import * as path from 'path';

/** Eklentinin Marketplace'te silinmeden önceki kimliği; eski depolama klasörü bu adı taşır. */
const OLD_EXTENSION_ID = 'aenzenith.pitwall';

/**
 * Kimlik `aenzenith.pitwall`'dan `aenzenith.pitwall-vscode`'a geçti; globalStorage
 * klasörü de değişti. Favoriler ve Claude "görüldü" kayıtları bir kez taşınır.
 * Yeni klasörde dosya varsa dokunulmaz. Pencere ve pid kayıtları geçicidir, taşınmaz.
 */
export function adoptOldStorage(storageDir: string): void {
    const oldDir = path.join(path.dirname(storageDir), OLD_EXTENSION_ID);

    if (oldDir === storageDir) {
        return;
    }

    for (const file of ['favorites.json', 'claude-seen.json']) {
        const from = path.join(oldDir, file);
        const to = path.join(storageDir, file);

        try {
            if (fs.existsSync(from) && !fs.existsSync(to)) {
                fs.mkdirSync(storageDir, { recursive: true });
                fs.copyFileSync(from, to);
            }
        } catch {
        }
    }
}
