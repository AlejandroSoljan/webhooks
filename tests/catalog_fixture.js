// Asisto | Version: 5.00.043 | Fecha: 2026-09-05
function fixture() {
  const rows = [], indexCalls = [];
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const col = {
    async createIndexes(specs) { indexCalls.push(specs); },
    async findOne(filter) { return rows.find(row => matches(row, filter)) || null; },
    find(filter) { return { limit(n) { return { async toArray() { return rows.filter(row => matches(row, filter)).slice(0, n); } }; } }; },
    async updateOne(filter, update) {
      let row = rows.find(row => matches(row, filter));
      if (!row) { row = { ...filter }; rows.push(row); }
      Object.assign(row, update.$set);
    },
  };
  return { rows, indexCalls, col, db: { collection: () => col } };
}
module.exports = { fixture };
