// Asisto | Version: 5.00.297 | Fecha: 2026-10-16
const dns = require('node:dns').promises;
const net = require('node:net');
const { fail, text, scopedId, hash } = require('./core');
const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(address, prefix, 'ipv4');
const mailbox = value => {
  const address = text(value || '', 254);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(address)) fail('mail_invalid_address');
  return address;
};
function configOf(input, previous) {
  const host = text(input.host || '', 253).toLowerCase(), port = Number(input.port);
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(host) || !host.includes('.') || net.isIP(host) || ![465,587].includes(port)) fail('mail_invalid_server');
  const user = text(input.user || '', 254), from = mailbox(input.from), name = text(input.name || '', 200);
  if (!user || /[\r\n\x00]/.test(user + name)) fail('mail_invalid_config');
  // Never silently reuse a password for a different SMTP account or server.
  const password = typeof input.password === 'string' && input.password ? input.password : previous?.host === host && previous?.user === user ? previous.password : '';
  if (!password || password.length > 2048 || /[\r\n\x00]/.test(password)) fail('mail_password_required');
  return { host, port, user, from, name, password };
}
async function publicAddress(host, resolve = value => dns.resolve4(value)) {
  let addresses;
  let timer;
  try { addresses = await Promise.race([resolve(host), new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),5000);})]); } catch { fail('mail_dns_failed', 502); } finally { clearTimeout(timer); }
  if (!addresses?.length || addresses.some(ip => net.isIP(ip) !== 4 || blocked.check(ip, 'ipv4'))) fail('mail_server_not_public');
  return addresses[0];
}
class SupportMail {
  constructor(service, { resolve, transportFactory = options => require('nodemailer').createTransport(options) } = {}) { this.s = service; this.resolve = resolve; this.factory = transportFactory; }
  id(scope) { return scopedId(scope, 'smtp'); }
  async config(scope) { const row = await this.s.col('mail_settings').findOne({ _id: this.id(scope), ...scope }); return row?.payload ? this.s.vault.open(row.payload, row._id) : null; }
  async view(scope) { const config = await this.config(scope); if (!config) return { configured: false }; const { password, ...safe } = config; return { configured: true, ...safe }; }
  async save(scope, input) {
    const config = configOf(input, await this.config(scope)), id = this.id(scope);
    await this.s.col('mail_settings').updateOne({ _id: id, ...scope }, { $set: { payload: this.s.vault.seal(config, id), updatedAt: this.s.now() }, $setOnInsert: scope }, { upsert: true });
    await this.s.audit(scope, 'smtp_config_saved', id);
    return this.view(scope);
  }
  async transport(config) {
    const ip = await publicAddress(config.host, this.resolve);
    return this.factory({ host: ip, port: config.port, secure: config.port === 465, requireTLS: config.port === 587,
      tls: { servername: config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: config.user, pass: config.password }, connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 8000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1 });
  }
  async verify(scope) {
    const config = await this.config(scope); if (!config) fail('mail_not_configured',409);
    const claim = await this.s.col('mail_settings').updateOne({ _id: this.id(scope), ...scope, $or: [{ testedAt: { $exists:false } }, { testedAt: { $lt: new Date(+this.s.now() - 10000) } }] }, { $set: { testedAt: this.s.now() } });
    if (!claim.matchedCount) fail('mail_rate_limited',429);
    const transport = await this.transport(config);
    try { await transport.verify(); return { verified: true }; } catch { fail('mail_connection_failed',502); } finally { transport.close?.(); }
  }
  async history(scope, draftId) {
    return this.s.col('mail_attempts').find({ ...scope, draftId }, { projection: { _id:1, state:1, at:1, finishedAt:1 } }).sort({ at:-1 }).limit(10).toArray();
  }
  async send(scope, draft, input) {
    if (input.confirm !== true) fail('mail_confirmation_required');
    const key = text(input.key || '', 100); if (!/^[a-f0-9-]{32,64}$/.test(key)) fail('mail_invalid_key');
    const to = mailbox(input.to), subject = text(input.subject || '', 300), body = text(input.body || '', 50000);
    if (!subject || !body || /[\r\n\x00]/.test(subject)) fail('mail_invalid_message');
    const id = scopedId(scope, 'mail', draft._id, key), digest = hash(to,subject,body);
    const existing = await this.s.col('mail_attempts').findOne({ _id:id, ...scope });
    if (existing) { if (existing.digest !== digest) fail('mail_key_conflict',409); return { id, state:existing.state, duplicate:true }; }
    if (await this.s.col('mail_attempts').countDocuments({ ...scope, at:{ $gt:new Date(+this.s.now()-3600000) } }) >= 30) fail('mail_rate_limited',429);
    const config = await this.config(scope); if (!config) fail('mail_not_configured',409);
    const slot = await this.s.col('mail_settings').updateOne({_id:this.id(scope),...scope,$or:[{sendAt:{$exists:false}},{sendAt:{$lt:new Date(+this.s.now()-3000)}}]},{$set:{sendAt:this.s.now()}});
    if (!slot.matchedCount) fail('mail_rate_limited',429);
    // Resolve and pin a public address before reserving; never connect to internal networks.
    const transport = await this.transport(config);
    try {
      try { await this.s.col('mail_attempts').insertOne({ _id:id, ...scope, draftId:draft._id, ticketId:draft.hubspot?.ticketId || null, digest, state:'sending', at:this.s.now(), payload:this.s.vault.seal({to,subject,body,from:config.from},id) }); }
      catch (error) { if (error.code !== 11000) throw error; const row=await this.s.col('mail_attempts').findOne({_id:id,...scope}); if(row.digest!==digest)fail('mail_key_conflict',409);return {id,state:row.state,duplicate:true}; }
      let state = 'uncertain';
      try {
        const result = await transport.sendMail({ from:{name:config.name,address:config.from}, to:{address:to}, subject, text:body, messageId:`<${id}@asistobot.com.ar>`, disableFileAccess:true, disableUrlAccess:true });
        state = result.accepted?.length ? 'accepted' : 'rejected';
      } catch (error) { if (Number(error.responseCode) >= 500 || error.code === 'EAUTH' || error.code === 'EENVELOPE') state = 'rejected'; }
      // An ambiguous timeout is not retried: the SMTP server may have accepted the message.
      await this.s.col('mail_attempts').updateOne({_id:id,...scope},{$set:{state,finishedAt:this.s.now()}});
      await this.s.audit(scope,'task_email_'+state,draft._id);
      return { id, state };
    } finally { transport.close?.(); }
  }
}
module.exports = { SupportMail, configOf, publicAddress, mailbox };
