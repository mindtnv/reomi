/** Disposable local acceptance dataset; only the two generated owners are deleted.
 * NODE_ENV=test OPERATIONS_PROOF_DATABASE=<local-test-db> bun --env-file=.env apps/api/scripts/operations-query-proof.ts
 */
import assert from 'node:assert/strict';
import { db, user, closeDb } from '@reomi/db';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { newUuidV7, OPERATION_GROUPS, type OperationGroup } from '@reomi/shared';
import { listOperations } from '../src/modules/operations';

const target = new URL(process.env.TEST_DATABASE_URL ?? 'http://invalid');
if (process.env.NODE_ENV !== 'test' || !['localhost', '127.0.0.1'].includes(target.hostname)
  || !process.env.OPERATIONS_PROOF_DATABASE || decodeURIComponent(target.pathname.slice(1)) !== process.env.OPERATIONS_PROOF_DATABASE) {
  throw new Error('Explicit matching local test database required');
}
const owners = [newUuidV7(), newUuidV7()], sourceId = newUuidV7();
try {
  await db.insert(user).values(owners.map((id, n) => ({ id, name: `Operation query fixture ${n}`, email: `operation-query-${id}@example.test` })));
  await db.execute(sql`INSERT INTO sources (id,user_id,kind,title,status,verified,chunk_count)
    VALUES (${sourceId}::uuid,${owners[0]},'text','Owned parent','ready',true,1)`);
  await db.execute(sql`INSERT INTO sources (user_id,kind,title,status,verified,chunk_count,operation_run_id,operation_started_at,operation_finished_at)
    SELECT ${owners[0]}, 'text', 'Owned source '||n,
      CASE WHEN n%1000=0 THEN 'pending' WHEN n%1000=1 THEN 'error' ELSE 'ready' END,
      true, 1, uuidv7(), now()-interval '40 days',
      CASE WHEN n%1000=0 THEN NULL WHEN n%10=0 OR n%1000=1 THEN now() ELSE now()-interval '40 days' END
    FROM generate_series(1,20000) n`);
  await db.execute(sql`INSERT INTO sources (user_id,kind,title,status,verified,operation_run_id,operation_started_at,operation_finished_at)
    SELECT ${owners[1]}, 'text', 'Foreign source '||n, 'ready', true, uuidv7(), now()-interval '40 days', now()-interval '40 days'
    FROM generate_series(1,40000) n`);
  await db.execute(sql`INSERT INTO notebook_artifacts (user_id,owner_kind,source_id,source_origin_id,source_origin_title,type,title,status,source_ids,operation_run_id,operation_started_at,operation_finished_at)
    SELECT ${owners[0]}, 'source', ${sourceId}::uuid, ${sourceId}::uuid, 'Owned parent', 'summary', 'Owned artifact '||n,
      CASE WHEN n%1000=0 THEN 'pending' WHEN n%1000=1 THEN 'error' ELSE 'ready' END,
      jsonb_build_array(${sourceId}::text), uuidv7(), now()-interval '40 days',
      CASE WHEN n%1000=0 THEN NULL WHEN n%10=0 OR n%1000=1 THEN now() ELSE now()-interval '40 days' END
    FROM generate_series(1,10000) n`);
  await db.execute(sql`ANALYZE sources`); await db.execute(sql`ANALYZE notebook_artifacts`);
  const execute = db.execute.bind(db), statements: SQL[] = [];
  db.execute = ((statement: SQL) => { statements.push(statement); return execute(statement); }) as typeof db.execute;
  try { await listOperations(owners[0]!, { limit: 50 }); } finally { db.execute = execute; }
  const plans = [];
  for (const [index, statement] of statements.entries()) {
    const result = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
    const plan = (result[0]!['QUERY PLAN'] as any[])[0];
    const nodes: object[] = [];
    const visit = (node: any) => { if (node['Relation Name'] || node['Index Name']) nodes.push({ type: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'], rows: node['Actual Rows'], loops: node['Actual Loops'] }); for (const child of node.Plans ?? []) visit(child); };
    visit(plan.Plan); plans.push({ group: OPERATION_GROUPS[index], executionMs: plan['Execution Time'], nodes });
  }
  const times: number[] = [];
  for (let n = 0; n < 20; n++) { const start = performance.now(); await listOperations(owners[0]!, { limit: 50 }); times.push(performance.now() - start); }
  const seen = Object.fromEntries(OPERATION_GROUPS.map(group => [group, new Set<string>()])) as Record<OperationGroup, Set<string>>;
  const wanted = new Set<OperationGroup>(OPERATION_GROUPS), cursors: Partial<Record<`${OperationGroup}Cursor`, string>> = {};
  let pages = 0;
  while (wanted.size) {
    assert.ok(++pages <= 100, 'pagination must terminate');
    const feed = await listOperations(owners[0]!, { limit: 50, ...cursors });
    for (const group of wanted) {
      const page = feed[group]; assert.ok(page.items.length <= 50);
      for (const row of page.items) { const key = `${row.kind}:${row.id}`; assert.ok(!seen[group].has(key)); assert.ok(row.title.startsWith('Owned ')); seen[group].add(key); }
      if (page.nextCursor) { assert.notEqual(page.nextCursor, cursors[`${group}Cursor`]); cursors[`${group}Cursor`] = page.nextCursor; }
      else { assert.equal(seen[group].size, page.total); wanted.delete(group); delete cursors[`${group}Cursor`]; }
    }
  }
  const totals = Object.fromEntries(OPERATION_GROUPS.map(group => [group, seen[group].size]));
  assert.deepEqual(totals, { active: 30, attention: 30, recent: 2970 });
  const sessionId = newUuidV7();
  await db.execute(sql`INSERT INTO ui_action_receipts (user_id,session_id,request_id,request_hash,kind,target,label,expires_at,undo_until)
    SELECT CASE WHEN n<=20000 THEN ${owners[0]} ELSE ${owners[1]} END, ${sessionId}::uuid, uuidv7(), 'fixture', 'source-metadata',
      jsonb_build_object('kind','source','id',${sourceId}::text,'revision','1'), 'Synthetic metadata edit',
      CASE WHEN n%20=0 THEN now()+interval '7 days' ELSE now()-interval '1 day' END,
      CASE WHEN n%20=0 THEN now()+interval '10 minutes' ELSE now()-interval '8 days' END
    FROM generate_series(1,40000) n`);
  await db.execute(sql`INSERT INTO operation_retry_receipts (user_id,request_id,kind,entity_id,observed_run_id,result_run_id,request_hash,created_at)
    SELECT CASE WHEN n<=4000 THEN ${owners[0]} ELSE ${owners[1]} END,uuidv7(),'source',${sourceId}::uuid,uuidv7(),uuidv7(),'fixture',
      CASE WHEN n%20=0 THEN now() ELSE now()-interval '8 days' END FROM generate_series(1,8000) n`);
  await db.execute(sql`ANALYZE ui_action_receipts`); await db.execute(sql`ANALYZE operation_retry_receipts`);
  const [action] = await db.execute(sql`SELECT request_id FROM ui_action_receipts WHERE user_id=${owners[0]} LIMIT 1`);
  const [retry] = await db.execute(sql`SELECT request_id FROM operation_retry_receipts WHERE user_id=${owners[0]} LIMIT 1`);
  const receiptQueries = [
    ['action-lookup', 'ui_action_owner_request_idx', sql`SELECT * FROM ui_action_receipts WHERE user_id=${owners[0]} AND request_id=${action!.request_id}::uuid LIMIT 1`],
    ['offers', 'ui_action_owner_session_order_idx', sql`SELECT * FROM ui_action_receipts WHERE user_id=${owners[0]} AND session_id=${sessionId}::uuid AND undo_until>now() AND consumed_at IS NULL ORDER BY id DESC NULLS LAST LIMIT 21`],
    ['action-cleanup-candidates', 'ui_action_expiry_idx', sql`SELECT id FROM ui_action_receipts WHERE expires_at<now() ORDER BY expires_at LIMIT 500`],
    ['retry-lookup', 'operation_retry_owner_request_idx', sql`SELECT * FROM operation_retry_receipts WHERE user_id=${owners[0]} AND request_id=${retry!.request_id}::uuid LIMIT 1`],
    ['retry-cleanup-candidates', 'operation_retry_created_idx', sql`SELECT id FROM operation_retry_receipts WHERE created_at<now()-interval '7 days' ORDER BY created_at LIMIT 500`],
  ] as const;
  const receiptPlans = [];
  for (const [name, expected, statement] of receiptQueries) {
    const rows = await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
    const plan = (rows[0]!['QUERY PLAN'] as any[])[0], indexes = new Set<string>();
    const visit = (node: any) => { if (node['Index Name']) indexes.add(node['Index Name']); for (const child of node.Plans ?? []) visit(child); }; visit(plan.Plan);
    assert.ok(indexes.has(expected), `${name} must use its receipt index`);
    receiptPlans.push({ name, executionMs: plan['Execution Time'], indexes: [...indexes], rows: plan.Plan['Actual Rows'] });
  }
  times.sort((a,b) => a-b);
  console.log(JSON.stringify({ seededRows: 70001, ownerRows: 30001, totals, pages, p50Ms: times[10], p95Ms: times[18], plans, receiptRows: 48000, receiptPlans }, null, 2));
} finally {
  await db.delete(user).where(inArray(user.id, owners));
  await closeDb();
}
