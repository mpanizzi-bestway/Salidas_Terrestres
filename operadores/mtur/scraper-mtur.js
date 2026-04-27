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
  // Estructura real del DOM de Mtur:
  //   h5.btn.btn-default "Incluye:"
  //   div.col-lg-12
  //     p.btn.btn-light "- Bus Semicama..."
  //     p.btn.btn-light "- Coordinador Acompañante"
  //     ...
  //     p.btn.btn-light "Todos nuestros paquetes... ver seguro"  ← omitir
  const incluye = [];
  let enIncluye = false;

  $('h5, p').each((_, el) => {
    const tag  = el.tagName?.toLowerCase();
    const cls  = ($(el).attr('class') || '');
    const text = $(el).text().trim().replace(/\s+/g, ' ');

    // Detectar h5 "Incluye:"
    if (tag === 'h5' && /incluye\s*:/i.test(text)) {
      enIncluye = true; return;
    }
    // Parar al llegar al siguiente h5 de sección (No incluye, Opciones, etc.)
    if (enIncluye && tag === 'h5') {
      enIncluye = false; return;
    }

    // Capturar p.btn.btn-light dentro de la sección incluye
    if (enIncluye && tag === 'p' && cls.includes('btn-light')) {
      // Omitir la línea del seguro
      if (/ver\s+seguro|todos\s+nuestros\s+paquetes/i.test(text)) return;
      // Limpiar: quitar el "- " inicial que viene como texto tras el ícono
      const clean = text.replace(/^[-–]\s*/, '').trim();
      if (clean.length > 3 && clean.length < 300) incluye.push(clean);
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

  // ── HOTELES + PRECIOS POR HOTEL ──────────────────────────────────────────
  // Estructura real: h5 "Opciones de hoteles:" → uno o más bloques:
  //   h3 [Hotel A] → fechas → h5 Doble → strong USD → h5 Triple → ...
  //   h3 [Hotel B] → fechas → h5 Doble → strong USD → h5 Triple → ...

  const hoteles = [];
  const CATS_RX = /^(doble|triple|cu[aá]druple|single|child|infante)$/i;

  let enHoteles = false;
  let hotelActual = null;
  let lastCat = null;

  // Iterar sobre todos los nodos relevantes de una sola vez
  $('h5, h4, h3, strong, b, p').each((_, el) => {
    const tag  = el.tagName?.toLowerCase();
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!tag) return;

    // Inicio de sección hoteles
    if ((tag === 'h5' || tag === 'h4') && /opciones\s+de\s+hoteles/i.test(text)) {
      enHoteles = true; return;
    }

    // Fin: llegamos a Observaciones
    if (enHoteles && (tag === 'h5' || tag === 'h4') && /^observaciones/i.test(text)) {
      if (hotelActual) { hoteles.push(hotelActual); hotelActual = null; }
      enHoteles = false; return;
    }

    if (!enHoteles) return;

    // Nuevo hotel → h3
    if (tag === 'h3') {
      if (hotelActual) hoteles.push(hotelActual);
      const nombre = $(el).text().trim().replace(/[-–\s]+$/, '').trim();
      const url    = $(el).find('a').first().attr('href') || '';
      hotelActual = {
        nombre,
        url: !/javascript/i.test(url) ? url : '',
        precios: {},
      };
      lastCat = null;
      return;
    }

    // Stop: texto "Precios por persona en base doble" → reiniciar lastCat
    if (hotelActual && /precios por persona/i.test(text)) {
      lastCat = null; return;
    }

    // Categoría de precio
    if (hotelActual && (tag === 'h5' || tag === 'h4') && CATS_RX.test(text)) {
      lastCat = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return;
    }

    // Valor: strong/b con "USD XXXX"
    if (hotelActual && lastCat && (tag === 'strong' || tag === 'b')) {
      const pm = text.match(/USD\s*([\d.,]+)/i) || text.match(/^([\d.,]+)$/);
      if (pm) {
        hotelActual.precios[lastCat] = parseFloat(pm[1].replace(',', '.'));
        lastCat = null;
      }
      return;
    }

    // Valor: "N/A" como texto plano en <p> o texto del párrafo
    if (hotelActual && lastCat && /^N\/A$/i.test(text)) {
      hotelActual.precios[lastCat] = null;
      lastCat = null;
    }
  });
  // Push del último hotel si no se guardó (la sección Observaciones pudo no aparecer)
  if (hotelActual && !hoteles.find(h => h.nombre === hotelActual.nombre)) {
    hoteles.push(hotelActual);
  }
  // Deduplicar por nombre (N/A como texto plano puede haber causado re-disparo)
  const hotelesUniq = hoteles.filter((h, i, arr) =>
    arr.findIndex(x => x.nombre === h.nombre) === i
  );
  const precios = hotelesUniq.length > 0 ? hotelesUniq[0].precios : {};

  // ── FECHAS DE SALIDA ──────────────────────────────────────────────────────
  const fechaRx  = /\b(\d{2}\/\d{2}\/\d{4})\b/g;
  const fechasSalida = [];
  let fm;
  while ((fm = fechaRx.exec(bodyText)) !== null) {
    if (!fechasSalida.includes(fm[1])) fechasSalida.push(fm[1]);
  }

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
    hoteles:      hotelesUniq,
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

  const outPath = path.join(__dirname, '..', '..', 'programas-mtur.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ ${result.programas.length} programas guardados en programas-mtur.json`);
}

scrapeAll().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
