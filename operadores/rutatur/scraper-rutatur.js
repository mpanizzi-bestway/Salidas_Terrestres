/**
 * scraper-rutatur.js  –  BestWay Viajes
 * v2.0 — Abril 2026
 *
 * MEJORAS respecto a v1:
 *  ✅ Auto-discovery: extrae TODAS las excursiones activas desde la home
 *     (elimina KNOWN_URLS hardcodeada — se actualiza solo cada semana)
 *  ✅ Parser robusto para las 2 variantes de precios de Rutatur:
 *       · doble/triple en la misma línea  → precioDobleTriple + precioPromo
 *       · doble, triple y single por línea separada con sus propias PROMs
 *       · single como recargo % o monto fijo
 *  ✅ Itinerario: captura correcta del último día (línea con HASTA LA PROXIMA)
 *  ✅ Highlights: ciudades del programa (segundo strong con " - ")
 *  ✅ Hoteles: sin incluir el marcador "HOTEL:" como ítem
 *  ✅ Texto de cada día separado del encabezado (sin duplicación)
 *  ✅ Salidas desde etiqueta Salidas: (antes de HOTEL:)
 *  ✅ Info general hasta marcador "Plaza de Cagancha"
 *  ✅ Imagen real del paquete desde rutatur.com
 *  ✅ Reintentos con back-off exponencial
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const path    = require('path');
const fs      = require('fs');

// ─── Configuración ──────────────────────────────────────────────────────────

const BASE_URL  = 'https://www.rutatur.com';
const OUT_PATH  = path.join(__dirname, '..', '..', 'programas-rutatur.json');
const DELAY_MS  = 1500;
const MAX_RETRY = 3;

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'es-UY,es;q=0.9',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer'        : 'https://www.rutatur.com/',
};

/** Items de "Incluye" fijos para TODOS los programas Rutatur */
const INCLUYE_FIJO = [
  'Bus semicama con guía/coordinador durante todo el recorrido.',
  'Incluye lo mencionado en el itinerario.',
  'Seguro médico para su viaje.',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = MAX_RETRY) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      console.warn(`  ⚠ Intento ${i + 1}/${retries} → ${url} [${status || err.message}]`);
      if (i < retries - 1) await sleep(DELAY_MS * (i + 2));
    }
  }
  throw new Error(`No se pudo obtener ${url} después de ${retries} intentos`);
}

function clean(str = '') {
  return str.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractId(url = '') {
  const m = url.match(/excursion-(\d+)/i);
  return m ? m[1] : null;
}

function extractSlug(url = '') {
  return url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
}

// ─── Auto-discovery desde la home ───────────────────────────────────────────

async function discoverUrls() {
  console.log('🔍 Descubriendo excursiones desde la home de Rutatur…');
  const html = await fetchWithRetry(BASE_URL + '/');
  const $    = cheerio.load(html);

  const programas = new Map(); // id → { id, url, titulo, precioDesde, salidaCard }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('excursion-')) return;

    const fullUrl = href.startsWith('http') ? href : BASE_URL + '/' + href.replace(/^\//, '');
    const id = extractId(fullUrl);
    if (!id || programas.has(id)) return;

    // Subir al contenedor de la card para tomar título y salida
    const card = $(el).closest('div, article, section').first();

    const titulo     = clean(card.find('h2, h3').first().text());
    const precioText = clean(card.find('[class*="precio"]').first().text());
    const precioNum  = precioText.match(/[\d]+/)?.[0] || '';
    const salidaCard = clean(card.find('li, p').first().text())
                         .replace(/^Salidas?:\s*/i, '');

    programas.set(id, { id, url: fullUrl, titulo, precioDesde: precioNum, salidaCard });
  });

  console.log(`   → ${programas.size} excursiones encontradas`);
  return [...programas.values()];
}

// ─── Parser de precios ───────────────────────────────────────────────────────

function parsePrecioBlock(texto) {
  const precios = {};

  // Variante A: "doble o triple U$S NNN / PROMO ... U$S MMM"
  const dtMatch = texto.match(/doble\s+o\s+triple\s+U\$S\s*([\d.,]+)/i);
  if (dtMatch) {
    precios.precioDobleTriple = dtMatch[1];
    const promoM = texto.match(/(?:PROMO|CONTADO)[^\n]*U\$S\s*([\d.,]+)/i);
    if (promoM) precios.precioPromo = promoM[1];
  } else {
    // Variante B: cada base en su propia línea → extraer los 2 primeros U$S de cada una
    const lineaDoble = texto.match(/BASE\s+DOBLE[^\n]*/i);
    if (lineaDoble) {
      const nums = [...lineaDoble[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.precioDoble      = nums[0][1];
      if (nums[1]) precios.precioPromoDoble = nums[1][1];
    }

    const lineaTriple = texto.match(/BASE\s+TRIPLE[^\n]*/i);
    if (lineaTriple) {
      const nums = [...lineaTriple[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.precioTriple      = nums[0][1];
      if (nums[1]) precios.precioPromoTriple = nums[1][1];
    }

    const lineaSingle = texto.match(/(?:HABITACION\s+)?SINGLE[^\n]*/i);
    if (lineaSingle) {
      const nums = [...lineaSingle[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.precioSingle      = nums[0][1];
      if (nums[1]) precios.precioPromoSingle = nums[1][1];
    }
  }

  // Single como recargo % (cuando no hay monto fijo)
  if (!precios.precioSingle) {
    const pctM = texto.match(/SINGLE\s+([\d]+)\s*%\s*M[AÁ]S/i);
    if (pctM) precios.singleRecargo = `+${pctM[1]}%`;
  }

  // Texto legible de la promo (primera ocurrencia)
  const promoTextoM = texto.match(/PROMO\s+([^\n*]+)/i);
  if (promoTextoM) precios.textoPromo = clean(promoTextoM[1]);

  return precios;
}

// ─── Parser de un programa individual ───────────────────────────────────────

function parsePrograma(htmlStr, meta) {
  const $ = cheerio.load(htmlStr);
  $('nav, header, footer, script, style, noscript').remove();

  // ── Título ──────────────────────────────────────────────────────────────
  const titulo = clean($('h2').first().text()) || meta.titulo;

  // ── Imagen ──────────────────────────────────────────────────────────────
  let imagen = '';
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('/excursiones/image/') && !imagen) {
      imagen = src.startsWith('http') ? src : BASE_URL + src;
    }
  });

  // ── Líneas de texto (solo nodos bloque, sin duplicar hijos) ─────────────
  const lineas = [];
  $('body').find('h2, h3, h4, h5, p, li').each((_, el) => {
    const txt = clean($(el).text());
    if (txt) lineas.push(txt);
  });
  const textoPlano = lineas.join('\n');

  // ── Highlights (ciudades/puntos de interés) ──────────────────────────────
  // Es el strong/em con " - " que NO es título, NO es día de itinerario,
  // NO contiene términos de precios/salidas, y aparece ANTES del itinerario
  let highlights = '';
  const itinerarioStart = lineas.findIndex(l => /^D[íi]a\s+01[\s\-–]/i.test(l));
  const buscarHasta = itinerarioStart !== -1 ? itinerarioStart : lineas.length;

  for (let i = 0; i < buscarHasta; i++) {
    const l = lineas[i];
    if (
      l.includes(' - ') &&
      l.length > 10 && l.length < 200 &&
      l !== titulo &&
      !l.match(/D[íi]a\s+\d+/i) &&
      !l.match(/Salida|HOTEL|COSTO|U\$S|SEGURO|BUTACA/i)
    ) {
      highlights = l;
      break;
    }
  }

  // ── Itinerario ───────────────────────────────────────────────────────────
  const itinerario = [];
  const inicioIdx  = lineas.findIndex(l => /^D[íi]a\s+01[\s\-–]/i.test(l));
  const finIdx     = lineas.findIndex(l => /HASTA LA PR[OÓ]XIMA EXCURSI[OÓ]N/i.test(l));

  if (inicioIdx !== -1 && finIdx !== -1) {
    let diaActual = null;
    let textosDia = [];

    const parseCabecera = (line) => {
      const m = line.match(/^(?:D[íi]a|DIAS?)\s+([\d\-]+)\s*[–\-]\s*(.+)/i);
      if (!m) return line;
      const num   = m[1].includes('-') ? m[1] : m[1].padStart(2, '0');
      const lugar = clean(m[2].replace(/HASTA LA PR[OÓ]XIMA.*/i, ''));
      return `Día ${num} – ${lugar}`;
    };

    for (let i = inicioIdx; i <= finIdx; i++) {
      const line  = lineas[i];
      const isDia = /^D[íi]a\s+\d+[\s\-–]/i.test(line) || /^DIAS?\s+[\d\-]+[\s\-–]/i.test(line);
      const isFin = /HASTA LA PR[OÓ]XIMA EXCURSI[OÓ]N/i.test(line);

      if (isFin) {
        // La línea final puede ser también el encabezado del último día
        if (isDia && !diaActual) {
          // Caso raro: fin en el primer día (programa de 1 día)
          itinerario.push({ dia: parseCabecera(line), texto: '' });
        } else if (isDia) {
          // Guardar día anterior y agregar este último
          if (diaActual) itinerario.push({ dia: diaActual, texto: textosDia.join(' ').trim() });
          itinerario.push({ dia: parseCabecera(line), texto: '' });
        } else if (diaActual) {
          // Texto del último día es parte de la línea fin (ej: "¡Llegada y HASTA LA PROXIMA…")
          const textoFin = line.replace(/HASTA LA PR[OÓ]XIMA EXCURSI[OÓ]N[!¡]*/i, '').trim();
          if (textoFin) textosDia.push(textoFin);
          itinerario.push({ dia: diaActual, texto: textosDia.join(' ').trim() });
        }
        break;
      }

      if (isDia) {
        if (diaActual) itinerario.push({ dia: diaActual, texto: textosDia.join(' ').trim() });
        diaActual = parseCabecera(line);
        // El texto del encabezado del día puede estar inline (strong + texto en el mismo <p>)
        // Lo separamos quitando la parte del encabezado
        const textoInline = clean(line.replace(/^(?:D[íi]a|DIAS?)\s+[\d\-]+\s*[–\-]\s*[^–\-]+/i, ''));
        textosDia = textoInline ? [textoInline] : [];
      } else if (diaActual) {
        textosDia.push(line);
      }
    }
  }

  // ── Salidas ──────────────────────────────────────────────────────────────
  // Tomar primera ocurrencia de "Salidas:" en el texto
  let salidas = '';
  const salidaM = textoPlano.match(/Salidas?:\s*([^\n]+)/i);
  if (salidaM) salidas = clean(salidaM[1]);

  // ── Hoteles ──────────────────────────────────────────────────────────────
  const hoteles = [];
  const hotelIdx = lineas.findIndex(l => /^HOTEL:$/i.test(l.trim()));
  if (hotelIdx !== -1) {
    for (let i = hotelIdx + 1; i < lineas.length; i++) {
      const l = clean(lineas[i]);
      if (!l) continue;
      // El bloque hotel termina cuando empieza precios o salida
      if (/Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA|U\$S\s+\d|^SALIDA\s+\d/i.test(l)) break;
      hoteles.push(l);
    }
  } else {
    // Fallback: línea con estrellas/URL y nombre de hotel
    for (const l of lineas) {
      if (
        l.match(/\*{2,}|\.com\.br/i) &&
        l.match(/HOTEL|RESORT|PARK\s+HOTEL|INN|MIRAMAR|MACHADINHO|COSTAO|FAZZENDA/i) &&
        !hoteles.includes(l)
      ) hoteles.push(l);
    }
  }

  // ── Bloque de precios ────────────────────────────────────────────────────
  const ps = textoPlano.search(/(?:Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA)/i);
  const pe = textoPlano.search(/Plaza de Cagancha/i);
  const precioBlock = ps !== -1 ? textoPlano.slice(ps, pe !== -1 ? pe : undefined) : '';
  const precios = parsePrecioBlock(precioBlock);

  // ── Info general ─────────────────────────────────────────────────────────
  let infoGeneral = '';
  const infoM = textoPlano.match(
    /(?:-\s*)?(?:MENOR(?:ES)?|Costo de la butaca|BUTACA|MENORES HASTA)[\s\S]+?(?=Plaza de Cagancha)/i
  );
  if (infoM) infoGeneral = clean(infoM[0]);

  return {
    id          : meta.id,
    slug        : extractSlug(meta.url),
    url         : meta.url,
    titulo,
    imagen,
    highlights,
    incluye     : INCLUYE_FIJO,
    itinerario,
    salidas,
    hoteles,
    precios,
    infoGeneral,
    scrapedAt   : new Date().toISOString(),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('🚌 Scraper Rutatur v2 – BestWay Viajes\n');

  // 1. Descubrir URLs desde la home
  let discovered;
  try {
    discovered = await discoverUrls();
  } catch (err) {
    console.error('❌ Error en auto-discovery:', err.message);
    process.exit(1);
  }

  if (!discovered.length) {
    console.error('❌ No se encontraron excursiones en la home.');
    process.exit(1);
  }

  // 2. Scrape de cada programa
  const programas = [];
  let errores = 0;

  for (const meta of discovered) {
    console.log(`\n📄 [${meta.id}] ${meta.titulo || meta.url}`);
    await sleep(DELAY_MS);

    try {
      const html = await fetchWithRetry(meta.url);
      const prog = parsePrograma(html, meta);
      programas.push(prog);

      const precioLabel = prog.precios.precioDobleTriple
        ? `doble/triple U$S ${prog.precios.precioDobleTriple}`
        : prog.precios.precioDoble
          ? `doble U$S ${prog.precios.precioDoble}`
          : '?';

      console.log(
        `   ✅  ${prog.itinerario.length} días | ${prog.hoteles[0]?.substring(0, 40) || '—'} | ${precioLabel}`
      );
    } catch (err) {
      console.error(`   ❌  ${err.message}`);
      errores++;
    }
  }

  // 3. Guardar JSON
  try {
    fs.writeFileSync(OUT_PATH, JSON.stringify(programas, null, 2), 'utf8');
    console.log(`\n✅ ${programas.length} programas guardados → ${OUT_PATH}`);
    if (errores > 0) console.warn(`⚠  ${errores} programas fallaron`);
  } catch (err) {
    console.error('❌ Error escribiendo JSON:', err.message);
    process.exit(1);
  }
})();
