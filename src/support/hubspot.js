// Asisto | Version: 5.00.095 | Fecha: 2026-09-10
const { fail, text, SupportError } = require('./core');

class HubSpotContract {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetch = fetchImpl; }
  async request(path, body, method = body ? 'POST' : 'GET') {
    // All paths are generated here. Never accept an arbitrary host or redirect with credentials.
    const response = await this.fetch(`https://api.hubapi.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const code = response.status === 401 ? 'hubspot_invalid_credentials' : response.status === 403 ? 'hubspot_insufficient_scopes' : response.status === 429 ? 'hubspot_rate_limited' : 'hubspot_request_failed';
      const error = new SupportError(code, response.status === 401 || response.status === 403 ? 409 : 502);
      error.remoteStatus = response.status; throw error;
    }
    return response.json();
  }
  async metadata() {
    const [properties, pipelines, companies, contacts, owners] = await Promise.all([
      this.request('/crm/v3/properties/tickets'), this.request('/crm/v3/pipelines/tickets'),
      this.request('/crm/v4/associations/tickets/companies/labels'), this.request('/crm/v4/associations/tickets/contacts/labels'),
      this.owners(),
    ]);
    return { properties: properties.results, pipelines: pipelines.results, owners, associationTypes: { companies: companies.results, contacts: contacts.results } };
  }
  async owners() {
    const results = []; let after;
    do {
      const page = await this.request(`/crm/v3/owners?limit=500&archived=false${after ? '&after=' + encodeURIComponent(after) : ''}`);
      results.push(...(page.results || []).filter(owner => !owner.archived)); after = page.paging?.next?.after;
      if (after && results.length >= 2000) fail('hubspot_owner_search_incomplete', 409);
    } while (after);
    return results;
  }
  async identity(companyId, contactId) {
    const company = await this.request(`/crm/v3/objects/companies/${encodeURIComponent(text(companyId))}?properties=name`);
    let contact = null;
    if (contactId) {
      contact = await this.request(`/crm/v3/objects/contacts/${encodeURIComponent(text(contactId))}?properties=firstname,lastname&associations=companies`);
      if (!contact.associations?.companies?.results?.some(row => row.id === company.id)) fail('contact_company_association_not_verified', 409);
    }
    return { companyId: company.id, company: company.properties.name || '', contactId: contact?.id || '', contact: contact ? [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ') : '' };
  }
  async companyTickets(companyId) {
    const results = [];
    let after;
    do {
      const page = await this.request('/crm/v3/objects/tickets/search', {
        filterGroups: [{ filters: [{ propertyName: 'associations.company', operator: 'EQ', value: text(companyId) }] }],
        properties: ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'createdate', 'closed_date'], limit: 100, ...(after ? { after } : {}),
      });
      results.push(...page.results); after = page.paging?.next?.after;
      if (after && results.length >= 1000) fail('hubspot_ticket_search_incomplete', 409);
    } while (after);
    return results;
  }
  async save(payload, ticketId) {
    if (ticketId) return this.request(`/crm/v3/objects/tickets/${encodeURIComponent(text(ticketId))}`, { properties: payload.properties }, 'PATCH');
    return this.request('/crm/v3/objects/tickets', payload);
  }
  async search(type, query = '', limit = 10) {
    if (!['companies', 'contacts'].includes(type)) fail('invalid_hubspot_object');
    const q = text(query, 200);
    return this.request(`/crm/v3/objects/${type}/search`, { ...(q ? { query: q } : {}), limit: Math.min(25, Math.max(1, Number(limit) || 10)), properties: type === 'companies' ? ['name', 'domain'] : ['firstname', 'lastname', 'email', 'phone', 'company'] });
  }
  async preflight() {
    const metadata = await this.metadata();
    await this.search('companies', '', 1);
    if (!metadata.properties.some(property => property.name === 'subject') || !metadata.properties.some(property => property.name === 'hs_pipeline_stage') || !metadata.properties.some(property => property.name === 'hubspot_owner_id') || !metadata.pipelines.some(pipeline => pipeline.stages?.length) || !metadata.owners?.length) fail('hubspot_ticket_schema_incomplete', 409);
    return { portalId: null, metadata };
  }
  prepare(fields, metadata, mapping) {
    const pipeline = metadata.pipelines.find(p => p.id === mapping.pipelineId);
    const stage = pipeline?.stages.find(s => s.id === mapping.stageId);
    if (!stage) fail('invalid_pipeline_stage');
    const properties = {};
    const put = (name, value, required = true) => {
      const property = metadata.properties.find(p => p.name === name);
      if (!property || property.modificationMetadata?.readOnlyValue) { if (required) fail('property_not_writable'); return; }
      if (property.type === 'enumeration' && property.options?.length && !property.options.some(o => !o.hidden && o.value === value)) fail('invalid_internal_option');
      properties[name] = value;
    };
    put('subject', fields.subject); put('content', fields.description);
    put('hs_pipeline', pipeline.id); put('hs_pipeline_stage', stage.id);
    const owner = metadata.owners?.find(row => String(row.id) === String(mapping.ownerId || ''));
    if (!owner) fail('invalid_hubspot_owner');
    put('hubspot_owner_id', String(owner.id));
    put('createdate', fields.messageDate, false);
    if (stage.metadata?.isClosed === 'true' || stage.metadata?.isClosed === true) {
      if (fields.closedDate) put('closed_date', fields.closedDate, false);
    }
    for (const [field, config] of Object.entries(mapping.fields || {})) {
      if (!['category', 'errorType', 'channel'].includes(field) || ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'createdate', 'closed_date'].includes(config.property)) fail('invalid_property_mapping');
      put(config.property, config.value ?? fields[field]);
    }
    const associations = [];
    for (const [type, id] of [['companies', fields.companyId], ['contacts', fields.contactId]]) {
      if (!id) continue;
      const association = metadata.associationTypes[type].find(t => t.category === 'HUBSPOT_DEFINED' && t.label == null);
      if (!association) fail('association_type_missing');
      associations.push({ to: { id }, types: [{ associationCategory: association.category, associationTypeId: association.typeId }] });
    }
    return { properties, associations };
  }
}
module.exports = { HubSpotContract };
