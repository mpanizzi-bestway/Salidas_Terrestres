/**
 * scraper-funtour.js — BestWay Viajes
 * v1.0 — Mayo 2026
 *
 * Scrapea todos los programas de Funtour desde funtour.com.uy/tienda/
 * El sitio es WooCommerce con SSR — Axios lo lee sin necesidad de JS.
 *
 * ESTRUCTURA JSON de salida:
 * {
 *   operador: 'Funtour',
 *   updatedAt: ISO string,
 *   programas: [{
 *     id, slug, operador, sourceUrl,
 *     titulo, subtitulo, duracion, destino, destinoSlug, pais, emoji,
 *     imagen, highlights[],
 *     incluye[], noIncluye[],
 *     hoteles[{ nombre, url }],
 *     itinerario[{ dia, lugar, detalle }],
 *     salidas[], bases[],
 *     precioDesde,
 *     fechas[{ label, value, gold }],
 *     temporada, notas[], updatedAt
 *   }]
 * }
 *
 * NOTA sobre precios por variante:
 * Funtour usa WooCommerce con variaciones (Salida × Base × Pasajeros).
 * El precio exacto por persona requiere interacción JS no disponible con Axios.
 * Se captura "precioDesde" de la etiqueta visible y "bases" (Single/Doble/Triple).
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE      = 'https://www.funtour.com.uy';
const TIENDA    = `${BASE}/tienda/`;
const OUT_PATH  = path.join(__dirname, '..', '..', 'programas-funtour.json');
const DELAY_MS  = 1400;
const MAX_RETRY = 3;

// Programas que NO son viajes terrestres/aéreos grupales
// (Disney, Surf Camp, cursos, etc.)
const SKIP_KEYWORDS = /disney|surf.?camp|springbreak|canguro|idance|broadway|teens|ski.?week|punta.?cana|wine.?tour/i;

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
let uaIdx = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function clean(s = '') {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchHTML(url, retries = MAX_RETRY) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent'     : UA_POOL[uaIdx++ % UA_POOL.length],
          'Accept'         : 'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'es-UY,es;q=0.9',
          'Referer'        : BASE,
        },
        maxRedirects: 5,
      });
      return res.data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2500 * (i + 1));
    }
  }
}

// ─── Mapas de destino ─────────────────────────────────────────────────────────

const DEST_SLUG_MAP = [
  [/cataratas|iguaz[uú]|foz/i,                          'cataratas'    ],
  [/florianop[oó]lis|floripa|bombinhas|ferrugem/i,       'florianopolis'],
  [/gramado|canela/i,                                    'gramado'      ],
  [/camboriu|cambori[uú]/i,                              'camboriu'     ],
  [/bariloche/i,                                         'bariloche'    ],
  [/mendoza/i,                                           'mendoza'      ],
  [/santiago.*chile|chile.*santiago|vina|valparaiso/i,   'chile'        ],
  [/carlos.?paz/i,                                       'carlospaz'    ],
  [/buenos.?aires/i,                                     'buenosaires'  ],
  [/rio\s+de\s+janeiro/i,                                'rio'          ],
  [/machadinho/i,                                        'machadinho'   ],
];

const PAIS_MAP = {
  cataratas:'Brasil', florianopolis:'Brasil', gramado:'Brasil',
  camboriu:'Brasil', rio:'Brasil', machadinho:'Brasil',
  bariloche:'Argentina', mendoza:'Argentina', carlospaz:'Argentina',
  buenosaires:'Argentina', chile:'Chile', otro:'Otros',
};

const EMOJI_MAP = {
  cataratas:'🌊', florianopolis:'🏖️', gramado:'🌲', camboriu:'🎡',
  rio:'🏙️', machadinho:'♨️',
  bariloche:'🏔️', mendoza:'🍷', carlospaz:'⛰️', buenosaires:'🏙️',
  chile:'🇨🇱', otro:'📍',
};

function inferSlug(titulo) {
  for (const [rx, slug] of DEST_SLUG_MAP) {
    if (rx.test(titulo)) return slug;
  }
  return 'otro';
}

// ─── Discovery desde /tienda/ ─────────────────────────────────────────────────
// Funtour usa WooCommerce con layout propio:
// - Títulos en <h4> con <a href="/tienda/slug/">
// - Precios en texto suelto "Desde: U$S NNN"
// - Imágenes en <img> dentro del mismo bloque

async function discoverUrls() {
  console.log('🔍 Descubriendo programas desde /tienda/...');
  const html = await fetchHTML(TIENDA);
  const $    = cheerio.load(html);
  const seen = new Map(); // slug → meta

  // Estrategia: buscar todos los <a href="/tienda/slug/"> que NO sean
  // navegación, newsletter, cupón, etc.
  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const txt   = clean($(el).text());

    // Solo links de productos individuales de la tienda
    if (!href.includes('/tienda/')) return;
    if (href === TIENDA || href === `${BASE}/tienda/`) return;

    // Extraer slug: todo lo que viene después de /tienda/
    const slug = href.replace(/^https?:\/\/[^/]+\/tienda\//, '').replace(/\/$/, '');
    if (!slug || slug.includes('/') || seen.has(slug)) return;

    // Obtener título: puede ser el texto del propio <a>, o el <h4> hermano
    let titulo = '';
    // Si el <a> es la imagen, subir al padre y buscar el <h4>
    const parent  = $(el).parent();
    const grandpa = parent.parent();
    titulo = clean(parent.find('h4, h3, h2').first().text())
          || clean(grandpa.find('h4, h3, h2').first().text())
          || clean(txt);

    if (!titulo || titulo.length < 3) return;
    if (SKIP_KEYWORDS.test(titulo)) return;

    // Precio: buscar en el mismo bloque
    const bloque = grandpa.length ? grandpa : parent;
    const precioTxt = clean(bloque.text());
    const precioM   = precioTxt.match(/U\$S\s*([\d.,]+)/i);
    const precio    = precioM ? precioM[1].replace(/\./g, '').replace(',', '') : '';

    // Imagen thumbnail del bloque
    const img = bloque.find('img').first().attr('src') || '';

    seen.set(slug, {
      slug,
      url       : href.startsWith('http') ? href : `${BASE}${href}`,
      titulo,
      precioDesde: precio,
      imgThumb  : img,
    });
  });

  // Fallback: buscar también por h4 > a directamente
  $('h4 a[href], h3 a[href]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const titulo = clean($(el).text());
    if (!href.includes('/tienda/')) return;
    const slug = href.replace(/^https?:\/\/[^/]+\/tienda\//, '').replace(/\/$/, '');
    if (!slug || slug.includes('/') || seen.has(slug)) return;
    if (!titulo || titulo.length < 3) return;
    if (SKIP_KEYWORDS.test(titulo)) return;
    seen.set(slug, {
      slug,
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      titulo,
      precioDesde: '',
      imgThumb: '',
    });
  });

  console.log(`   → ${seen.size} programas encontrados`);
  return [...seen.values()];
}

// ─── Parser de un programa ────────────────────────────────────────────────────

function parsePrograma(html, meta) {
  const $ = cheerio.load(html);

  // ── Título ────────────────────────────────────────────────────────────────
  const tituloRaw = clean(
    $('h1.product_title, h1.entry-title, h1.elementor-heading-title').first().text()
  ) || meta.titulo;

  // Quitar referencias a "Funtour" del título para la ficha BestWay
  const titulo = tituloRaw.replace(/\bfuntour\b/gi, '').replace(/\s{2,}/g, ' ').trim();

  // ── Imagen principal ──────────────────────────────────────────────────────
  let imagen = '';
  // WooCommerce: imagen principal en .woocommerce-product-gallery img
  $('div.woocommerce-product-gallery img, .product img').each((_, el) => {
    const src = $(el).attr('data-large_image') || $(el).attr('src') || '';
    if (!imagen && src && !src.includes('-150x150') && !src.includes('-300x300')) {
      imagen = src;
    }
  });
  if (!imagen) imagen = meta.imgThumb || '';

  // ── Incluye / No incluye ──────────────────────────────────────────────────
  const incluye    = [];
  const noIncluye  = [];
  const shortDesc  = $('.woocommerce-product-details__short-description');

  let enNoIncluye = false;
  shortDesc.find('p, li').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const txt = clean($(el).text());
    if (!txt) return;

    if (tag === 'p') {
      if (/^no\s+incluye/i.test(txt)) { enNoIncluye = true; return; }
      if (/^incluye/i.test(txt))      { enNoIncluye = false; return; }
    }
    if (tag === 'li') {
      // Filtrar líneas de exoneración de responsabilidad
      if (/eximiendo de responsabilidad|factores externos/i.test(txt)) return;
      if (enNoIncluye) noIncluye.push(txt);
      else             incluye.push(txt);
    }
  });

  // ── Hotel(es) desde short description ────────────────────────────────────
  const hoteles = [];
  shortDesc.find('a[href]').each((_, el) => {
    const nombre = clean($(el).text());
    const url    = $(el).attr('href') || '';
    if (nombre && url && !/funtour|condiciones/i.test(url)) {
      hoteles.push({ nombre, url });
    }
  });

  // ── Precio desde ──────────────────────────────────────────────────────────
  const precioTxt = clean($('p.price, .price').first().text());
  const precioM   = precioTxt.match(/[\d.,]+/);
  const precioDesde = precioM
    ? precioM[0].replace('.', '')
    : meta.precioDesde || '';

  // ── Itinerario ────────────────────────────────────────────────────────────
  // WooCommerce: tab "Descripción" en #tab-description
  const itinerario = [];
  const tabDesc    = $('#tab-description');

  tabDesc.find('p').each((_, el) => {
    const html_p = $(el).html() || '';
    const txt    = clean($(el).text());
    if (!txt || txt.length < 5) return;

    // Detectar encabezado de día: bold al inicio "Día N – LUGAR –"
    const strongTxt = clean($(el).find('strong').first().text());
    const diaM = strongTxt.match(/^D[ií]a\s+(\d+(?:-\d+)?)\s*[–\-]\s*(.+)/i);

    if (diaM) {
      const num    = diaM[1];
      const lugar  = clean(diaM[2].replace(/[–\-]+$/, '').replace(/\bFuntour\b/gi, '')).trim();
      // Detalle: texto del párrafo menos el strong del encabezado
      const detalle = clean(txt.replace(strongTxt, '').replace(/\bFuntour\s+Viajes\b/gi, '').trim());
      itinerario.push({
        dia    : `DÍA ${num.padStart(2, '0')}`,
        lugar  : lugar.substring(0, 80),
        detalle: detalle.substring(0, 800),
        first  : itinerario.length === 0,
        last   : false,
      });
    } else if (itinerario.length > 0) {
      // Párrafo adicional dentro del último día (vuelos, importante, etc.)
      // Solo añadir si no es el último día ya cerrado
      const last = itinerario[itinerario.length - 1];
      if (!last.last) {
        const txtClean = clean(txt.replace(/\bFuntour\s+Viajes?\b/gi, ''));
        if (txtClean.length > 5 && !last.detalle.includes(txtClean)) {
          last.detalle = (last.detalle + ' ' + txtClean).trim().substring(0, 800);
        }
      }
    }
  });

  if (itinerario.length > 0) {
    itinerario[itinerario.length - 1].last = true;
  }

  // ── Información adicional (salida, alojamiento, base) ─────────────────────
  const salidas = [];
  const bases   = [];
  let   hotelAttr = '';

  $('#tab-additional_information tr').each((_, el) => {
    const label = clean($(el).find('th').text()).toLowerCase();
    const value = clean($(el).find('td').text());
    if (!value || value === 'Elige una opción') return;

    if (/salida/.test(label)) {
      // Puede tener múltiples opciones separadas por newline
      value.split(/\n|,/).map(s => s.trim()).filter(Boolean).forEach(s => {
        if (!salidas.includes(s)) salidas.push(s);
      });
    }
    if (/alojamiento/.test(label)) hotelAttr = value;
    if (/base/.test(label)) {
      value.split(/,/).map(s => s.trim()).filter(Boolean).forEach(b => {
        if (!bases.includes(b)) bases.push(b);
      });
    }
  });

  // Si hay hotel en atributos y no está en hoteles, agregarlo
  if (hotelAttr && !hoteles.some(h => h.nombre.toLowerCase().includes(hotelAttr.toLowerCase()))) {
    hoteles.push({ nombre: hotelAttr, url: '' });
  }

  // ── Duración ──────────────────────────────────────────────────────────────
  const diasM   = tituloRaw.match(/(\d+)\s*[Dd][ií][aá]s?/);
  const nochesM = tituloRaw.match(/(\d+)\s*[Nn]oches?/);
  const dias    = diasM   ? diasM[1]   : itinerario.length ? String(itinerario.length) : '';
  const noches  = nochesM ? nochesM[1] : '';
  const durStr  = dias
    ? `${dias} DÍAS${noches ? ` / ${noches} NOCHES` : ''}`
    : itinerario.length > 0
      ? `${itinerario.length} DÍAS`
      : 'Consultar';

  // ── Temporada ─────────────────────────────────────────────────────────────
  let temporada = '';
  const tempM = tituloRaw.match(
    /\b(verano|invierno|vacaciones\s+de\s+\w+|semana\s+de\s+turismo|temporada\s+\w+|julio|agosto|setiembre|septiembre|diciembre|enero|febrero|marzo|abril|mayo|junio|natal|luz)\b/i
  );
  if (tempM) temporada = tempM[0].charAt(0).toUpperCase() + tempM[0].slice(1).toLowerCase();

  // ── Highlights ────────────────────────────────────────────────────────────
  const highlights = itinerario
    .filter(d => !/urugua|montevideo|colonia|tres\s+cruce/i.test(d.lugar))
    .slice(0, 5)
    .map(d => `📍 ${d.lugar.split('–')[0].split('-')[0].trim()}`);

  // ── Fechas para card ──────────────────────────────────────────────────────
  const fechas = [];
  if (salidas.length > 0) {
    fechas.push({ label: 'Salida', value: salidas[0], gold: true });
  }
  if (salidas.length > 1) {
    fechas.push({
      label: 'Otras salidas',
      value: salidas.slice(1).join(' · ').substring(0, 80),
      gold: false,
    });
  }
  if (bases.length > 0) {
    fechas.push({ label: 'Habitación', value: bases.join(' / '), gold: false });
  }

  // ── Destino ───────────────────────────────────────────────────────────────
  const destinoSlug = inferSlug(tituloRaw);

  // ── Slug e ID ─────────────────────────────────────────────────────────────
  const slug = meta.slug || meta.url.replace(/.*\/tienda\//, '').replace(/\/$/, '');
  const id   = `funtour-${slug}`;

  return {
    id,
    slug,
    operador    : 'funtour',
    sourceUrl   : meta.url,
    titulo,
    subtitulo   : durStr,
    duracion    : durStr,
    destino     : titulo,
    destinoSlug,
    pais        : PAIS_MAP[destinoSlug]  || 'Otros',
    emoji       : EMOJI_MAP[destinoSlug] || '📍',
    imagen,
    highlights,
    incluye,
    noIncluye,
    hoteles,
    itinerario,
    salidas,
    bases,
    precioDesde,
    fechas,
    temporada,
    notas       : [],
    updatedAt   : new Date().toISOString(),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function scrapeAll() {
  console.log('✈️  Scraper Funtour v1 — BestWay Viajes\n');

  const result = {
    operador  : 'Funtour',
    updatedAt : new Date().toISOString(),
    programas : [],
  };

  // 1. Descubrir URLs
  let items = [];
  try {
    items = await discoverUrls();
    if (!items.length) throw new Error('0 programas encontrados en /tienda/');
  } catch (e) {
    console.error('❌ Error en discovery:', e.message);
    process.exit(1);
  }

  // 2. Scrape de cada programa
  let errores = 0;
  for (const meta of items) {
    await sleep(DELAY_MS);
    console.log(`\n📄 ${meta.titulo}`);
    try {
      const html = await fetchHTML(meta.url);
      const prog = parsePrograma(html, meta);
      if (!prog?.titulo) { console.warn('   ⚠ Sin datos'); continue; }
      result.programas.push(prog);
      console.log(
        `   ✅ ${prog.itinerario.length} días | ` +
        `${prog.hoteles[0]?.nombre?.substring(0, 30) || '—'} | ` +
        `Desde U$S ${prog.precioDesde || '?'}`
      );
    } catch (e) {
      console.warn(`   ❌ ${e.message}`);
      errores++;
    }
  }

  if (!result.programas.length) {
    console.error('\n❌ Sin programas. JSON no sobreescrito.');
    process.exit(1);
  }

  result.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ ${result.programas.length} programas → ${OUT_PATH}`);
  if (errores) console.warn(`⚠  ${errores} programas fallaron`);
}

scrapeAll().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
