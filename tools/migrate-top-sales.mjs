import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/database.mjs';

const config = await loadConfig(process.argv[2] ?? 'config.json');
const db = openDatabase(config.databasePath);

try {
  db.exec('BEGIN');
  const sorted = db.prepare(`
    UPDATE products
    SET sort_order='Top Sales'
    WHERE product_url LIKE 'https://www.temu.com/%'
      AND product_url NOT LIKE '%goods_id=demo%'
      AND subcategory <> 'Demo'
  `).run();
  const reset = db.prepare(`
    UPDATE review_crawl_state
    SET status='pending',last_started_at=NULL,last_finished_at=NULL,last_error=NULL
    WHERE status IN ('failed','in_progress')
       OR (status='completed' AND last_review_count=0)
  `).run();
  db.exec('COMMIT');
  console.log(`Top Sales迁移完成：商品=${Number(sorted.changes)}，重新排队评论商品=${Number(reset.changes)}。`);
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
