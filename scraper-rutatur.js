/**
 * scraper-rutatur.js - BestWay Viajes
 * Scrapea todos los programas de Rutatur y genera programas-rutatur.json
 *
 * Estructura real confirmada del HTML de Rutatur:
 *   h2                  → título del programa
 *   img[src*=/usr/data] → imagen del programa
 *   "desde U$S XXX"     → precio desde (omitir)
 *   Texto corrido con **Dia 01 - LUGAR** texto... → itinerario
 *   "Salida XX de MES"  → al final del texto
 *   "U$S XXXX"          → precios inline
 *   "HOTEL www...."     → hoteles al final
 *   Lista *  al pie     → salidas confirmedas
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const BASE     = 'https://www.rutatur.com';
const INDEX    = `${BASE}/rutatur-excursiones-listado`;

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

// ─── URLs conocidas de Rutatur (fallback principal — el índice es SPA con hash) ──
// El listado usa /#/rutatur-excursiones-listado (Angular/Vue SPA)
// Axios no ejecuta JS, por lo que el índice dinámico no funciona.
// Mantener esta lista actualizada manualmente cuando se agregan programas.
const KNOWN_URLS = [
  // Termas
  `${BASE}/termas-de-machadinho-7-dias-excursion-771`,
  `${BASE}/termas-romanas-6-dias-excursion-773`,
  // Cataratas
  `${BASE}/cataratas-del-iguazu-7-dias4-noches-excursion-777`,
  // Rio de Janeiro / Shows
  `${BASE}/shakira-en-rio-de-janeiro-26-abr-26-excursion-802`,
  // Otros (agregar según se publiquen)
];

// ─── Descubrir URLs dinámicamente (intento — puede fallar en SPA) ─────────
async function getPackageUrls() {
  const urls = new Set(KNOWN_URLS);

  // Intentar descubrir desde el HTML base (funciona si hay links estáticos)
  try {
    const html = await fetchHTML(BASE);
    const $    = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/excursion-\d+/.test(href)) {
        const full = href.startsWith('http') ? href : `${BASE}${href}`;
        urls.add(full.split('?')[0]);
      }
    });

    // También intentar la página de listado estática
    const htmlList = await fetchHTML(`${BASE}/rutatur-excursiones-listado`);
    const $2 = cheerio.load(htmlList);
    $2('a[href]').each((_, el) => {
      const href = $2(el).attr('href') || '';
      if (/excursion-\d+/.test(href)) {
        const full = href.startsWith('http') ? href : `${BASE}${href}`;
        urls.add(full.split('?')[0]);
      }
    });
  } catch(e) {
    console.log(`   Índice dinámico no disponible (SPA): ${e.message}`);
    console.log(`   Usando ${KNOWN_URLS.length} URLs conocidas`);
  }

  return [...urls];
}

// ─── Inferir destino/país/emoji ────────────────────────────────────────────
function inferSlug(titulo) {
  const t = titulo.toLowerCase();
  if (/cataratas|iguaz[uú]|foz/i.test(t))              return 'cataratas';
  if (/florianop[oó]lis|floripa/i.test(t))              return 'florianopolis';
  if (/camboriu|cambori[uú]/i.test(t))                  return 'camboriu';
  if (/gramado|canela/i.test(t))                        return 'gramado';
  if (/fazzenda|fazenda/i.test(t))                      return 'fazzenda';
  if (/rio de janeiro|shakira.*rio|rio.*shakira/i.test(t)) return 'rio';
  if (/termas.*machadinho|machadinho/i.test(t))         return 'machadinho';
  if (/termas.*gravatal|gravatal/i.test(t))             return 'gravatal';
  if (/termas.*romanas|termas romanas/i.test(t))        return 'termasromanas';
  if (/jurere|jurer[eé]/i.test(t))                      return 'jurere';
  if (/bariloche/i.test(t))                             return 'bariloche';
  if (/mendoza/i.test(t))                               return 'mendoza';
  if (/norte argentino|salta|jujuy/i.test(t))           return 'norte';
  if (/carlos paz/i.test(t))                            return 'carlospaz';
  if (/buenos aires/i.test(t))                          return 'buenosaires';
  if (/chile|santiago/i.test(t))                        return 'chile';
  return 'otro';
}

const PAIS_MAP = {
  cataratas:'Cataratas', florianopolis:'Brasil', camboriu:'Brasil',
  gramado:'Brasil', fazzenda:'Brasil', rio:'Brasil',
  machadinho:'Brasil', gravatal:'Brasil', termasromanas:'Argentina',
  jurere:'Brasil',
  bariloche:'Argentina', mendoza:'Argentina', norte:'Argentina',
  carlospaz:'Argentina', buenosaires:'Argentina', chile:'Chile', otro:'Otros',
};
const EMOJI_MAP = {
  cataratas:'🌊', florianopolis:'🏖️', camboriu:'🎡', gramado:'🌲',
  fazzenda:'🌿', rio:'🏙️', machadinho:'♨️', gravatal:'♨️',
  termasromanas:'♨️', jurere:'🏖️',
  bariloche:'🏔️', mendoza:'🍷', norte:'🏔️', carlospaz:'⛰️',
  buenosaires:'🏙️', chile:'🇨🇱', otro:'📍',
};

// ─── Parser principal ──────────────────────────────────────────────────────
function parseProgram(html, sourceUrl) {
  const $ = cheerio.load(html);

  // ID desde URL: /termas-excursion-771 → "771"
  const idM    = sourceUrl.match(/excursion-(\d+)/);
  const rutaId = idM ? idM[1] : String(Date.now());

  // ── TÍTULO ────────────────────────────────────────────────────────────────
  const tituloRaw = $('h2').first().text().trim().replace(/\s+/g, ' ');
  if (!tituloRaw || tituloRaw.length < 3) return null;
  // Limpiar duración del título en cualquier posición
  const titulo = tituloRaw
    .replace(/\s*[-–]?\s*\d+\s*d[ií]as?\s*(?:[\/\s]*\d*\s*noches?)?/gi, '')
    .replace(/\s*[-–]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // ── IMAGEN ────────────────────────────────────────────────────────────────
  let imagen = '';
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!imagen && src.includes('/usr/data/excursiones/')) {
      imagen = src.startsWith('http') ? src : `${BASE}${src}`;
    }
  });

  // ── CONTENIDO PRINCIPAL ───────────────────────────────────────────────────
  // Rutatur vuelca todo en texto corrido — extraer el bloque principal
  // Está en el div que contiene el h2 del programa (no el nav)
  let contenidoEl = null;
  $('div').each((_, el) => {
    const text = $(el).text();
    if (text.includes('Día 01') || text.includes('DIA 01') ||
        text.includes('Dia 01') || text.includes('SALIDA') ||
        text.includes('Salida')) {
      if (!contenidoEl || $(el).text().length > $(contenidoEl).text().length) {
        contenidoEl = el;
      }
    }
  });

  const rawText = contenidoEl
    ? $(contenidoEl).text()
    : $('body').text();

  const lines = rawText.split('\n')
    .map(l => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

  // ── DÍAS / NOCHES ─────────────────────────────────────────────────────────
  const diasM   = titulo.match(/(\d+)\s*D[ií]as?/i) || rawText.match(/(\d+)\s*D[ií]as?\b/i);
  const nochesM = titulo.match(/(\d+)\s*Noches?/i)  || rawText.match(/(\d+)\s*Noches?\b/i);
  const dias    = diasM   ? diasM[1]   : '';
  const noches  = nochesM ? nochesM[1] : '';

  // ── ITINERARIO ─────────────────────────────────────────────────────────────
  // Formato: **Día 01 – LUGAR** texto | **DIA 02 – LUGAR** texto
  // Marcador de fin: "Salida" / precios / "Plaza Cagancha"
  const itinerario = [];
  const DIA_RX = /\*{0,2}D[ií]a\s+(\d{2}(?:\s*(?:y|Y|al|AL)\s*\d{2})?|0?\d)\s*[:\-–]+\s*([^\*\n]{2,60?})\*{0,2}[\s\-–:]+(.{5,})/gi;

  let dm;
  while ((dm = DIA_RX.exec(rawText)) !== null) {
    const diaRaw = dm[1].trim();
    const lugar  = dm[2].trim().replace(/\*+/g, '').replace(/[:\-–]+$/, '').trim();
    const posActual = dm.index + dm[0].length;
    const resto     = rawText.slice(posActual);

    // Límite: próximo día, o "Salida", o "Plaza Cagancha", o precios
    const limites = [
      resto.search(/\*{0,2}D[ií]a\s+\d{1,2}\b/i),
      resto.search(/\bSalida\s+\d|\*Salida/i),
      resto.search(/Plaza\s+Cagancha/i),
      resto.search(/\bU\$S\s+\d{3,}/),
    ].filter(p => p > 0);

    const dist    = limites.length > 0 ? Math.min(...limites) : 600;
    const bloque  = rawText.slice(dm.index + dm[0].length - dm[3].length, dm.index + dm[0].length + dist);

    // Cortar en "Fin de nuestros servicios" o "HASTA LA PROXIMA"
    const finIdx = bloque.search(/hasta la pr[oó]xima|fin de nuestros/i);
    const detalle = (finIdx >= 0 ? bloque.slice(0, finIdx) + 'Fin de nuestros servicios.' : bloque)
      .replace(/\*+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 700);

    if (lugar.length > 0 && detalle.length > 5) {
      itinerario.push({
        dia:    `DÍA ${diaRaw.toUpperCase()}`,
        lugar:  lugar.substring(0, 60),
        detalle,
        first:  itinerario.length === 0,
        last:   false,
      });
    }
  }
  if (itinerario.length > 0) itinerario[itinerario.length - 1].last = true;

  // ── SALIDAS ───────────────────────────────────────────────────────────────
  // Aparecen AL FINAL del documento, en formatos variados:
  // "Salida 09 de MAYO - HORA 14:00hs"
  // "***Salida 26 DE ABRIL 2026 - Hora de Salida 09:00Hs***"
  // "* Salida 09 Mayo 2026 - 12:00hs"  ← lista al pie
  const salidas = [];
  const SALIDA_RX = /\*{0,3}\s*Salida\s+([^\n\*]{5,80?}(?:hs|Hs|HRS)?)/gi;
  let sm;
  while ((sm = SALIDA_RX.exec(rawText)) !== null) {
    const val = sm[1].trim().replace(/\*+/g, '').replace(/\s+/g, ' ');
    if (val.length > 3 && !salidas.includes(val)) salidas.push(val);
  }

  // ── HOTELES ───────────────────────────────────────────────────────────────
  // Formato al final del texto: "HOTEL NOMBRE www.web.com" o "HOTELES:\nNOMBRE www.web.com"
  const hoteles = [];
  // Buscar líneas que parezcan hoteles (nombre en mayúsculas + www.)
  for (const line of lines) {
    // Omitir líneas del nav/footer
    if (/Plaza Cagancha|Pocitos|rutatur\.com$|Montevideo|Uruguay|copyright/i.test(line)) continue;
    if (/www\./i.test(line) && /[A-Z]{4,}/.test(line)) {
      // Separar nombre de URL
      const parts = line.split(/\s+(?=www\.)/);
      const nombre = parts[0].replace(/\*+/g, '').replace(/^HOTEL(ES)?:?\s*/i, '').trim();
      const url    = parts[1] || '';
      if (nombre.length > 2 && nombre.length < 80) {
        // Evitar duplicados y falsos positivos (RUTATUR, MONTEVIDEO, etc.)
        if (!/RUTATUR|MONTEVIDEO|URUGUAY|CAGANCHA|POCITOS|BRASIL|ARGENTINA/i.test(nombre)) {
          hoteles.push({ nombre, url });
        }
      }
    }
  }

  // ── PRECIOS ───────────────────────────────────────────────────────────────
  // Formatos: "U$S 629", "PROMO PAGO CONTADO U$S 589", "Single: 35 % MAS"
  // También: "U$S 789 *** PROMO PAGO CONTADO U$S 719 ***"
  const precios = {};

  // Doble/Triple
  const dblM = rawText.match(/(?:doble\/?triple|base\s+doble[^\n]*?)[\s:]*U\$S\s*([\d.,]+)/i);
  if (dblM) precios.doble = parseFloat(dblM[1].replace(',', '.'));

  // Promo / contado
  const promoM = rawText.match(/PROMO\s+(?:PAGO\s+)?(?:CONTADO\s+)?(?:O\s+TRANSFERENCIA\s+)?U\$S\s*([\d.,]+)/i);
  if (promoM) precios.promo = parseFloat(promoM[1].replace(',', '.'));

  // Triple separado
  const tplM = rawText.match(/BASE\s+TRIPLE[^\n]*?U\$S\s*([\d.,]+)/i)
            || rawText.match(/TRIPLE[:\s]+U\$S\s*([\d.,]+)/i);
  if (tplM) precios.triple = parseFloat(tplM[1].replace(',', '.'));

  // Single
  const sglM = rawText.match(/(?:COSTO\s+)?(?:HABITACION\s+)?SINGLE[:\s]+U\$S\s*([\d.,]+)/i);
  if (sglM) precios.single = parseFloat(sglM[1].replace(',', '.'));

  // Single "35% mas"
  if (!precios.single && rawText.match(/single\s*:?\s*35\s*%\s*M[AÁ]S/i)) {
    precios.singleLabel = 'Single: 35% adicional';
  }

  // Butaca / solo asiento
  const butacaM = rawText.match(/(?:COSTO DE LA )?BUTACA[:\s]+U\$S\s*([\d.,]+)|SOLO\s+ASIENTO[:\s]+U\$S\s*([\d.,]+)/i);
  if (butacaM) precios.butaca = parseFloat((butacaM[1] || butacaM[2]).replace(',', '.'));

  // Menor gratuito
  const menorGratisM = rawText.match(/MENOR(?:ES)?\s+hasta\s+(\d+)\s+a[ñn]os?[^.]*(?:ES\s+NUESTRO\s+INVITADO|SIN\s+CARGO)/i);
  if (menorGratisM) precios.menorGratis = `Menores hasta ${menorGratisM[1]} años: invitado`;

  // ── SEGURO ────────────────────────────────────────────────────────────────
  const tieneSeguro = /SEGURO DE ASISTENCIA\s+INCLUIDO|SEGURO\s+INCLUIDO/i.test(rawText);

  // ── NOTAS / OBSERVACIONES ─────────────────────────────────────────────────
  // Líneas con info importante: menores, política de cancelación, etc.
  const notas = [];
  for (const line of lines) {
    if (/menor|asiento|butaca|contado|promo|importante|políticas|cancelación|señ/i.test(line) &&
        line.length > 15 && line.length < 400 &&
        !/Plaza Cagancha|www\.rutatur|Pocitos|Montevideo/i.test(line)) {
      const clean = line.replace(/\*+/g, '').trim();
      if (!notas.includes(clean)) notas.push(clean);
    }
  }

  // ── SLUG / IDENTIFICADORES ────────────────────────────────────────────────
  const destSlug = inferSlug(titulo);
  const slug     = `rutatur-${rutaId}`;
  const durStr   = dias ? `${dias} DÍAS${noches ? ` / ${noches} NOCHES` : ''}` : '';

  // ── TEMPORADA ─────────────────────────────────────────────────────────────
  // Rutatur la incluye en el título o en el texto: "TURISMO 2026", "VERANO", etc.
  let temporada = '';
  const tempM = titulo.match(/\b(verano|invierno|oto[ñn]o|primavera|baja\s+temporada|alta\s+temporada|turismo\s+\d{4}|\d{4})\b/i);
  if (tempM) temporada = tempM[0].trim();
  // Fallback: buscar en el texto "Salida X de MES AÑO" → extraer mes/año
  if (!temporada && salidas.length > 0) {
    const mesM = salidas[0].match(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)\b/i);
    if (mesM) temporada = mesM[0].charAt(0).toUpperCase() + mesM[0].slice(1).toLowerCase() + (salidas[0].match(/\b(202\d)\b/)?.[0] ? ' ' + salidas[0].match(/\b(202\d)\b/)[0] : '');
  }
  const fechasPrograma = [];
  if (salidas.length > 0) {
    fechasPrograma.push({
      label: 'Salida',
      value: salidas[0].substring(0, 80),
      gold: true,
    });
  }
  if (salidas.length > 1) {
    fechasPrograma.push({
      label: 'Otras salidas',
      value: salidas.slice(1, 4).join(' · ').substring(0, 80),
      gold: false,
    });
  }

  // ── HIGHLIGHTS desde el itinerario ────────────────────────────────────────
  const highlights = itinerario
    .slice(0, 6)
    .map(d => `📍 ${d.lugar}`)
    .filter(h => !/montevideo/i.test(h));

  return {
    id:           slug,
    rutaId,
    operador:     'rutatur',
    sourceUrl,
    titulo,
    subtitulo:    durStr || 'Consultar',
    duracion:     durStr || 'Consultar',
    destino:      titulo,
    destinoSlug:  destSlug,
    pais:         PAIS_MAP[destSlug]  || 'Otros',
    emoji:        EMOJI_MAP[destSlug] || '📍',
    imagen,
    highlights,
    fechas:       fechasPrograma,
    salidas,
    itinerario,
    hoteles,
    precios,
    temporada,
    notas,
    updatedAt:    new Date().toISOString(),
  };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function scrapeAll() {
  console.log('Iniciando scraping de Rutatur...\n');

  const result = {
    operador:  'Rutatur',
    updatedAt: new Date().toISOString(),
    programas: [],
  };

  console.log('Leyendo listado de excursiones...');
  let urls = [];
  try {
    urls = await getPackageUrls();
    console.log(`   ${urls.length} excursiones encontradas\n`);
  } catch (e) {
    console.error('Error al obtener indice:', e.message);
    process.exit(1);
  }

  if (urls.length === 0) {
    console.error('Sin URLs encontradas.');
    process.exit(1);
  }

  for (const url of urls) {
    await sleep(1100);
    try {
      const html = await fetchHTML(url);
      const prog = parseProgram(html, url);
      if (prog?.titulo) {
        result.programas.push(prog);
        console.log(`OK [${prog.rutaId}] ${prog.titulo}`);
      } else {
        console.warn(`Sin datos: ${url}`);
      }
    } catch (e) {
      console.warn(`Error en ${url}: ${e.message}`);
    }
  }

  if (result.programas.length === 0) {
    console.error('Sin programas obtenidos. JSON no sobreescrito.');
    process.exit(1);
  }

  const outPath = path.join(__dirname, 'programas-rutatur.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n${result.programas.length} programas guardados en programas-rutatur.json`);
}

scrapeAll().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
