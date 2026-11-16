'use strict';
// Unit bisnis bawaan. Setiap unit memiliki pelanggan, produk, pesanan, transaksi, dan laporan sendiri (via business_unit_id).
module.exports = [
  { code: 'agency', name: 'GERDEV Digital Agency', description: 'Jasa pembuatan website dan layanan digital.', services: ['Pembuatan website', 'Landing page', 'Website UMKM', 'Toko online', 'Maintenance website'] },
  { code: 'products', name: 'GERDEV Digital Products', description: 'Produk digital siap pakai.', services: ['Template website', 'Template desain', 'Produk digital', 'Asset digital'] },
  { code: 'marketing', name: 'GERDEV Creative Marketing', description: 'Layanan kreatif dan pemasaran.', services: ['Desain promosi', 'Konten media sosial', 'Copywriting', 'Strategi pemasaran'] },
  { code: 'commerce', name: 'GERDEV Online Commerce', description: 'Katalog, penjualan, dan pengelolaan pesanan online.', services: ['Katalog produk', 'Penjualan', 'Pengelolaan pesanan'] }
];
