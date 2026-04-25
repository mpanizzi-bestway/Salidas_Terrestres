/**
 * scraper-mtur.js — BestWay Viajes
 * Scrapea todos los paquetes terrestres de Mtur Viajes
 * Genera: programas-mtur.json
 *
 * Estructura real del HTML de Mtur (confirmada):
 *   h1                    → título
 *   img[src*=dropbox]     → imagen del paquete
 *   "DuraciónX días / Y noches | TemporadaZ"  → duración + temporada
 *   "Visitando [Ciudad, Ciudad]"               → highlights
 *   h5 "Incluye:" → li items (omitir "ver seguro")
 *   h5 "No incluye:" → p siguiente
 *   h5 "Opciones de hoteles:" → h3 con a links
 *   dd/mm/yyyy como texto → fechas de salida
 *   h5 "Doble/Triple/..." → strong "USD XXXX" → tabla de precios
 *   a "Itinerario" → PDF link
 *   h5 "Observaciones:" → texto variable
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const BASE  = 'https://www.mturviajes.com.uy';
const INDEX = `${BASE}/terrestres`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
let uaIdx = 0;

async function fetchHTML(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': UA_POOL[uaIdx++ % UA_POOL.length],
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'es-UY,es;q=0.9',
          'Referer': BASE,
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

// ─── Descubrir URLs de paquetes en /terrestres ─────────────────────────────
async function getPackageUrls() {
  const html = await fetchHTML(INDEX);
  const $    = cheerio.load(html);
  const urls = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/\/paquetes\/\d+\/\d+/.test(href)) {
      const full = href.startsWith('http') ? href : `${BASE}${href}`;
      urls.add(full.split('?')[0]); // limpiar query strings
    }
  });
  return [...urls];
}

// ─── Inferir destino / país / emoji ───────────────────────────────────────
function inferSlug(titulo, visitando) {
  const t = (titulo + ' ' + visitando).toLowerCase();
  if (/cataratas|iguaz[uú]|foz/i.test(t))             return 'cataratas';
  if (/florianop[oó]lis|floripa|canasvieiras/i.test(t)) return 'florianopolis';
  if (/gramado|canela/i.test(t))                       return 'gramado';
  if (/rio de janeiro|corcovado/i.test(t))             return 'rio';
  if (/bariloche|patagonia/i.test(t))                  return 'bariloche';
  if (/mendoza/i.test(t))                              return 'mendoza';
  if (/norte argentino|salta|jujuy|tucum[aá]n/i.test(t)) return 'norte';
  if (/carlos paz|c[oó]rdoba/i.test(t))               return 'carlospaz';
  if (/cambori[uú]/i.test(t))                          return 'camboriu';
  if (/buenos aires|temaiken/i.test(t))                return 'buenosaires';
  if (/termas/i.test(t))                               return 'termas';
  if (/chile|santiago/i.test(t))                       return 'chile';
  if (/europa/i.test(t))                               return 'europa';
  if (/caribe/i.test(t))                               return 'caribe';
  return 'otro';
}

const PAIS_MAP = {
  cataratas:'Cataratas', florianopolis:'Brasil', gramado:'Brasil', rio:'Brasil', camboriu:'Brasil',
  bariloche:'Argentina', mendoza:'Argentina', norte:'Argentina', carlospaz:'Argentina', buenosaires:'Argentina',
  termas:'Brasil', chile:'Chile', europa:'Europa', caribe:'Caribe', otro:'Otros',
};
const EMOJI_MAP = {
  cataratas:'🌊', florianopolis:'🏖️', gramado:'🌲', rio:'🏙️', camboriu:'🎡',
  bariloche:'🏔️', mendoza:'🍷', norte:'🏔️', carlospaz:'⛰️', buenosaires:'🏙️',
  termas:'♨️', chile:'🇨🇱', europa:'🌍', caribe:'🌴', otro:'📍',
};

// ─── Parser principal ──────────────────────────────────────────────────────
function parseProgram(html, sourceUrl) {
  const $ = cheerio.load(html);

  // ID desde URL: /paquetes/803/2 → "803"
  const idM  = sourceUrl.match(/\/paquetes\/(\d+)\//);
  const mturId = idM ? idM[1] : String(Date.now());

  // ── TÍTULO ────────────────────────────────────────────────────────────────
  const titulo = $('h1').first().text().trim().replace(/\s+/g, ' ');
  if (!titulo || titulo.length < 3) return null;

  // ── IMAGEN ────────────────────────────────────────────────────────────────
  // Primera img cuya src apunta a Dropbox o CDN propio de Mtur
  let imagen = '';
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!imagen && (src.includes('dropbox') || src.includes('digitalocean') || src.includes('dropboxusercontent'))) {
      imagen = src;
    }
  });

  // ── TEXTO COMPLETO del body para búsquedas de texto plano ─────────────────
  const bodyText = $('body').text();

  // ── DURACIÓN Y TEMPORADA ──────────────────────────────────────────────────
  // Formato confirmado: "Duración11 días / 8 noches | TemporadaBaja Temporada 2026"
  let dias = '', noches = '', temporada = '';
  const durM = bodyText.match(/Duraci[oó]n\s*(\d+)\s*d[ií]as?\s*\/\s*(\d+)\s*noches?/i);
  if (durM) { dias = durM[1]; noches = durM[2]; }
  const tempM = bodyText.match(/Temporada\s*([^\n]{3,60}?)(?:\n|Incluye)/i);
  if (tempM) temporada = tempM[1].trim().replace(/\s+/g, ' ');

  // ── VISITANDO → highlights ────────────────────────────────────────────────
  // Formato: "Visitando\n[Ciudad](js) \n[Ciudad](js)" — links en cheerio
  let visitando = '';
  const highlights = [];

  // Buscar el texto después del literal "Visitando"
  const visitIdx = bodyText.search(/\bVisitando\b/i);
  if (visitIdx >= 0) {
    const after = bodyText.slice(visitIdx + 9, visitIdx + 300);
    // Tomar hasta "Duración" o "Incluye" o doble newline
    const corte = after.search(/Duraci[oó]n|Incluye|\n\n/i);
    visitando = (corte > 0 ? after.slice(0, corte) : after)
      .replace(/\s+/g, ' ').trim();
  }
  if (visitando) {
    visitando.split(/,|\n/).map(c => c.trim()).filter(c => c.length > 1)
      .forEach(c => highlights.push(`📍 ${c}`));
  }

  // ── INCLUYE ───────────────────────────────────────────────────────────────
  // Sección h5 "Incluye:" → li items hasta "ver seguro" (omitir)
  const incluye = [];
  let enIncluye = false;

  $('*').each((_, el) => {
    const tag  = el.tagName?.toLowerCase();
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!tag) return;

    if ((tag === 'h5' || tag === 'h4') && /^incluye\s*:/i.test(text)) {
      enIncluye = true; return;
    }
    if (enIncluye) {
      // Parar al llegar a la siguiente sección
      if ((tag === 'h5' || tag === 'h4') && !/^incluye/i.test(text)) {
        enIncluye = false; return;
      }
      if (tag === 'li') {
        if (/ver\s+seguro/i.test(text)) return;          // omitir link seguro
        if (/todos\s+nuestros\s+paquetes/i.test(text)) return; // omitir texto genérico
        if (text.length > 3 && text.length < 300) incluye.push(text);
      }
    }
  });

  // ── NO INCLUYE ────────────────────────────────────────────────────────────
  let noIncluye = '';
  let enNoIncluye = false;
  $('*').each((_, el) => {
    const tag  = el.tagName?.toLowerCase();
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!tag) return;
    if ((tag === 'h5' || tag === 'h4') && /^no\s+incluye/i.test(text)) {
      enNoIncluye = true; return;
    }
    if (enNoIncluye) {
      if ((tag === 'h5' || tag === 'h4')) { enNoIncluye = false; return; }
      if ((tag === 'p' || tag === 'li') && text.length > 3) {
        noIncluye = text.substring(0, 300);
        enNoIncluye = false;
      }
    }
  });

  // ── HOTELES ───────────────────────────────────────────────────────────────
  // h5 "Opciones de hoteles:" → h3 con uno o más <a> (nombre-ciudad)
  const hoteles = [];
  let enHoteles = false;
  $('*').each((_, el) => {
    const tag  = el.tagName?.toLowerCase();
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!tag) return;
    if ((tag === 'h5' || tag === 'h4') && /opciones\s+de\s+hoteles/i.test(text)) {
      enHoteles = true; return;
    }
    if (enHoteles && tag === 'h3') {
      $(el).find('a').each((_, a) => {
        // Nombre viene como "HOTEL CIUDAD-" → limpiar guión final
        const nombre = $(a).text().trim().replace(/[-–\s]+$/, '').trim();
        const url    = $(a).attr('href') || '';
        if (nombre.length > 1 && !/javascript/i.test(url)) {
          hoteles.push({ nombre, url });
        }
      });
      enHoteles = false;
    }
    if (enHoteles && (tag === 'h5' || tag === 'h4') && !/opciones/i.test(text)) {
      enHoteles = false;
    }
  });

  // ── FECHAS DE SALIDA ──────────────────────────────────────────────────────
  // Formato: "09/05/2026\n04/07/2026" — texto plano entre hoteles y precios
  const fechaRx  = /\b(\d{2}\/\d{2}\/\d{4})\b/g;
  const fechasSalida = [];
  let fm;
  while ((fm = fechaRx.exec(bodyText)) !== null) {
    if (!fechasSalida.includes(fm[1])) fechasSalida.push(fm[1]);
  }

  // ── PRECIOS ───────────────────────────────────────────────────────────────
  // h5 "Doble" → strong "USD 1195" / "N/A"
  // Categorías en orden: Doble, Triple, Cuádruple, Single, Child, Infante
  const CATS_RX = /^(doble|triple|cu[aá]druple|single|child|infante)$/i;
  const precios  = {};
  let lastCat    = null;

  $('h5, strong, b, span').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (CATS_RX.test(text)) {
      lastCat = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return;
    }
    if (lastCat) {
      const pm = text.match(/USD\s*([\d.,]+)/i) || text.match(/^([\d.,]+)$/);
      if (pm) {
        precios[lastCat] = parseFloat((pm[1]).replace(',','.'));
        lastCat = null;
      } else if (/^N\/A$/i.test(text)) {
        precios[lastCat] = null;
        lastCat = null;
      }
    }
  });

  // ── PDF ITINERARIO ────────────────────────────────────────────────────────
  let pdfItinerario = '';
  $('a').each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href') || '';
    if (/^itinerario$/i.test(text) && href.length > 10) {
      pdfItinerario = href;
    }
  });

  // ── OBSERVACIONES ─────────────────────────────────────────────────────────
  let observaciones = '';
  let enObs = false;
  $('*').each((_, el) => {
    const tag  = el.tagName?.toLowerCase();
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!tag) return;
    if ((tag === 'h5' || tag === 'h4') && /^observaciones/i.test(text)) {
      enObs = true; return;
    }
    if (enObs) {
      // Parar al llegar al footer
      if (/Mtur Reservas|Mercedes 1499|© 20\d\d|Descargar paquete/i.test(text)) {
        enObs = false; return;
      }
      if ((tag === 'p' || tag === 'strong' || tag === 'div') && text.length > 3) {
        // Evitar duplicar si el texto ya está incluido
        if (!observaciones.includes(text.substring(0, 30))) {
          observaciones += (observaciones ? '\n' : '') + text;
        }
      }
    }
  });
  observaciones = observaciones.trim().substring(0, 1000);

  // ── SLUG / IDs ─────────────────────────────────────────────────────────────
  const destSlug = inferSlug(titulo, visitando);
  const slug     = `mtur-${mturId}`;
  const durStr   = dias ? `${dias} DÍAS${noches ? ` / ${noches} NOCHES` : ''}` : 'Consultar';

  // ── FECHAS PARA PLANTILLA ─────────────────────────────────────────────────
  const fechasPrograma = [];
  if (fechasSalida.length > 0) {
    fechasPrograma.push({
      label: 'Salidas',
      value: fechasSalida.slice(0, 5).join('  ·  '),
      gold: true,
    });
  }
  if (temporada) {
    fechasPrograma.push({ label: 'Temporada', value: temporada, gold: false });
  }

  return {
    id:           slug,
    mturId,
    operador:     'mtur',
    sourceUrl,
    titulo,
    subtitulo:    [durStr, temporada].filter(Boolean).join(' · '),
    duracion:     durStr,
    destino:      visitando || titulo,
    destinoSlug:  destSlug,
    pais:         PAIS_MAP[destSlug]  || 'Otros',
    emoji:        EMOJI_MAP[destSlug] || '📍',
    imagen,
    visitando,
    highlights,
    temporada,
    fechas:       fechasPrograma,
    incluye,
    noIncluye,
    hoteles,
    fechasSalida,
    precios,
    pdfItinerario,
    observaciones,
    updatedAt:    new Date().toISOString(),
  };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function scrapeAll() {
  console.log('🚀 Iniciando scraping de Mtur Viajes...\n');

  const result = {
    operador:  'Mtur Viajes',
    updatedAt: new Date().toISOString(),
    programas: [],
  };

  // Fase 1: descubrir URLs
  console.log('📋 Leyendo listado de paquetes terrestres...');
  let urls = [];
  try {
    urls = await getPackageUrls();
    console.log(`   ${urls.length} paquetes encontrados\n`);
  } catch (e) {
    console.error('❌ Error al obtener índice:', e.message);
    process.exit(1);
  }

  if (urls.length === 0) {
    console.error('❌ No se encontraron URLs.');
    process.exit(1);
  }

  // Fase 2: scrapear cada paquete
  for (const url of urls) {
    await sleep(1000);
    try {
      const html = await fetchHTML(url);
      const prog = parseProgram(html, url);
      if (prog?.titulo) {
        result.programas.push(prog);
        console.log(`✅ [${prog.mturId}] ${prog.titulo}`);
      } else {
        console.warn(`⚠️  Sin datos: ${url}`);
      }
    } catch (e) {
      console.warn(`❌ Error en ${url}: ${e.message}`);
    }
  }

  if (result.programas.length === 0) {
    console.error('\n❌ Sin programas obtenidos. JSON no sobreescrito.');
    process.exit(1);
  }

  const outPath = path.join(__dirname, 'programas-mtur.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ ${result.programas.length} programas guardados en programas-mtur.json`);
}

scrapeAll().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
