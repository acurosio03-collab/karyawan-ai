'use strict';
// Eksekusi tindakan setelah Owner APPROVE. Tindakan yang belum punya integrasi nyata TIDAK dipura-purakan:
// hasilnya dicatat sebagai "executed:false" dengan alasan, agar tidak ada klaim palsu.
const integrations = require('./integrations');
const { HttpError } = require('../lib/http');

async function deliver(db, ws, p) {
  if (!p || !p.text || !p.to || !['whatsapp', 'email'].includes(p.channel)) return { executed: false, note: 'Disetujui, tetapi payload tidak memuat channel/to/text. Kirim manual.' };
  if (!(await integrations.isEnabled(db, ws, p.channel))) return { executed: false, note: 'Integrasi ' + p.channel + ' dinonaktifkan Owner (NOT CONNECTED). Kirim manual.' };
  const r = p.channel === 'whatsapp' ? await integrations.sendWhatsApp(p.to, p.text) : await integrations.sendEmail(p.to, p.subject, p.text);
  await db.exec('insert into communications (workspace_id, lead_id, customer_id, channel, direction, content, status) values ($1,$2,$3,$4,$5,$6,$7)',
    [ws, p.lead_id || null, p.customer_id || null, p.channel, 'out', p.text, r.sent ? 'terkirim' : 'gagal: ' + r.reason]).catch(() => {});
  return r.sent ? { executed: true, note: 'Pesan terkirim via ' + p.channel } : { executed: false, note: r.reason };
}

async function executeApproved(db, a) {
  const p = a.payload || {}; const ws = a.workspace_id;
  switch (a.action_type) {
    case 'send_message': return deliver(db, ws, p);
    case 'send_quotation': {
      if (!p.quotation_id) return { executed: false, note: 'payload.quotation_id tidak ada' };
      const d = await deliver(db, ws, p);
      if (d.executed) await db.exec("update quotations set status='sent' where id=$1 and workspace_id=$2", [p.quotation_id, ws]);
      else await db.exec("update quotations set status='draft' where id=$1 and workspace_id=$2 and status='pending_approval'", [p.quotation_id, ws]);
      return { ...d, note: d.executed ? 'Penawaran terkirim dan ditandai sent' : (d.note + ' Penawaran dikembalikan ke draft; kirim manual lalu ubah status di halaman Pesanan/Penawaran.') };
    }
    case 'issue_invoice': {
      if (!p.invoice_id) return { executed: false, note: 'payload.invoice_id tidak ada' };
      const n = await db.exec("update invoices set status='issued', issued_at=now() where id=$1 and workspace_id=$2 and status in ('draft','pending_approval')", [p.invoice_id, ws]);
      return n ? { executed: true, note: 'Invoice diterbitkan (status issued). Pengiriman ke pelanggan dilakukan terpisah.' } : { executed: false, note: 'Invoice tidak ditemukan atau sudah diproses' };
    }
    case 'accept_order': {
      if (!p.order_id) return { executed: false, note: 'payload.order_id tidak ada' };
      const n = await db.exec("update orders set status='confirmed' where id=$1 and workspace_id=$2 and status in ('draft','pending_approval')", [p.order_id, ws]);
      return n ? { executed: true, note: 'Pesanan diterima (confirmed)' } : { executed: false, note: 'Pesanan tidak ditemukan atau sudah diproses' };
    }
    default:
      return { executed: false, note: 'Persetujuan dicatat. Tindakan ini belum memiliki integrasi otomatis di V1; lakukan secara manual.' };
  }
}

async function decide(db, { workspaceId, id, userId, decision, note }) {
  const status = { approve: 'approved', reject: 'rejected', review: 'review' }[decision];
  if (!status) throw new HttpError(400, 'Keputusan tidak valid');
  return db.tx(async (t) => {
    const a = await t.one("select * from approvals where id=$1 and workspace_id=$2 and status in ('pending','review') for update", [id, workspaceId]);
    if (!a) throw new HttpError(409, 'Persetujuan tidak ditemukan atau sudah diputuskan');
    let result = null;
    if (decision === 'approve') result = await executeApproved(t, a);
    if (decision === 'reject') {
      const p = a.payload || {};
      if (a.action_type === 'send_quotation' && p.quotation_id) await t.exec("update quotations set status='draft' where id=$1 and workspace_id=$2 and status='pending_approval'", [p.quotation_id, workspaceId]);
      if (a.action_type === 'issue_invoice' && p.invoice_id) await t.exec("update invoices set status='draft' where id=$1 and workspace_id=$2 and status='pending_approval'", [p.invoice_id, workspaceId]);
    }
    const upd = await t.one('update approvals set status=$2, decided_by=$3, decided_at=now(), decision_note=$4, executed_at=$5, execution_result=$6::jsonb where id=$1 returning *',
      [id, status, userId, note || null, result && result.executed ? new Date() : null, result ? JSON.stringify(result) : null]);
    await t.exec('insert into audit_logs (workspace_id, user_id, action, entity, entity_id, details) values ($1,$2,$3,$4,$5,$6::jsonb)', [workspaceId, userId, 'approval.' + decision, 'approvals', id, JSON.stringify({ action_type: a.action_type, result })]);
    return upd;
  });
}
module.exports = { decide, executeApproved };
