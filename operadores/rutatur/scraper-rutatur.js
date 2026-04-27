/**
 * scraper-rutatur.js - BestWay Viajes
 * v2.0 — Mayo 2026
 *
 * MEJORAS respecto a v1:
 *  ✅ Auto-discovery desde home (elimina KNOWN_URLS hardcodeada)
 *     La home de rutatur.com es SSR — Axios la lee sin problema
 *  ✅ Parser de precios con ambas variantes:
 *       A) "doble o triple U$S 669 / PROMO ... U$S 599"
 *       B) BASE DOBLE / BASE TRIPLE / HABITACION SINGLE en líneas separadas
 *  ✅ Itinerario: captura correcta del último día (línea con HASTA LA PROXIMA)
 *  ✅ Hoteles: sin incluir el marcador "HOTEL:" como ítem
 *  ✅ Salidas: marca "Salidas:" como fuente primaria
 *  ✅ Info general hasta marcador "Plaza de Cagancha"
 *  ✅ Imagen real del paquete
 *  ✅ Reintentos con back-off exponencial
 *
 * ESTRUCTURA JSON de salida — 100% compatible con rutatur.html:
 *  {
 *    operador: 'Rutatur',
 *    updatedAt: ISO string,
 *    programas: [
 *      {
 *        id, rutaId, operador, sourceUrl,
 *        titulo, subtitulo, duracion, destino, destinoSlug, pais, emoji,
 *        imagen, highlights[], fechas[], salidas[],
 *        itinerario[{ dia, lugar, detalle, first, last }],
 *        hoteles[{ nombre, url }],
 *        precios{ doble?, triple?, promo?, promoDoble?, promoTriple?,
 *                 single?, promoSingle?, singleLabel?, butaca?, menorGratis? },
 *        temporada, notas[], updatedAt
 *      }
 *    ]
 *  }
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE     = 'https://www.rutatur.com';
const OUT_PATH = path.join(__dirname, '..', '..', 'programas-rutatur.json');
const DELAY_MS  = 1300;
const MAX_RETRY = 3;

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
let uaIdx = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  [/cataratas|iguaz[uú]|foz/i,                                       'cataratas'    ],
  [/florianop[oó]lis|floripa|costao/i,                                'florianopolis'],
  [/fazzenda|fazenda/i,                                               'fazzenda'     ],
  [/camboriu|cambori[uú]/i,                                           'camboriu'     ],
  [/gramado|canela/i,                                                 'gramado'      ],
  [/rio de janeiro|noche.*nostalgia.*rio|rio.*nostalgia|shakira.*rio/i,'rio'          ],
  [/machadinho/i,                                                     'machadinho'   ],
  [/gravatal/i,                                                       'gravatal'     ],
  [/termas\s+romanas/i,                                               'termasromanas'],
  [/\bit[aá]\b/i,                                                     'ita'          ],
  [/jurere|jurer[eé]/i,                                               'jurere'       ],
  [/porto\s+seguro/i,                                                 'portoseguro'  ],
  [/regi[oó]n.*lagos|lagos.*patag/i,                                  'lagos'        ],
  [/bariloche/i,                                                      'bariloche'    ],
  [/mendoza/i,                                                        'mendoza'      ],
  [/norte argentino|salta|jujuy/i,                                    'norte'        ],
  [/carlos\s*paz/i,                                                   'carlospaz'    ],
  [/buenos\s*aires/i,                                                 'buenosaires'  ],
  [/chile|santiago/i,                                                 'chile'        ],
];

const PAIS_MAP = {
  cataratas:'Cataratas', florianopolis:'Brasil', fazzenda:'Brasil',
  camboriu:'Brasil', gramado:'Brasil', rio:'Brasil',
  machadinho:'Brasil', gravatal:'Brasil', termasromanas:'Argentina',
  ita:'Brasil', jurere:'Brasil', portoseguro:'Brasil', lagos:'Argentina',
  bariloche:'Argentina', mendoza:'Argentina', norte:'Argentina',
  carlospaz:'Argentina', buenosaires:'Argentina', chile:'Chile', otro:'Otros',
};

const EMOJI_MAP = {
  cataratas:'🌊', florianopolis:'🏖️', fazzenda:'🌿', camboriu:'🎡',
  gramado:'🌲', rio:'🏙️', machadinho:'♨️', gravatal:'♨️',
  termasromanas:'♨️', ita:'♨️', jurere:'🏖️', portoseguro:'🏖️', lagos:'🏔️',
  bariloche:'🏔️', mendoza:'🍷', norte:'🏔️', carlospaz:'⛰️',
  buenosaires:'🏙️', chile:'🇨🇱', otro:'📍',
};

function inferSlug(titulo) {
  for (const [rx, slug] of DEST_SLUG_MAP) {
    if (rx.test(titulo)) return slug;
  }
  return 'otro';
}

// ─── Auto-discovery desde la home ────────────────────────────────────────────
// La home de rutatur.com es SSR — Axios la lee sin necesidad de JS.
// Lista todos los programas activos con "Ver más >" y sus URLs.

async function discoverUrls() {
  console.log('🔍 Descubriendo excursiones desde la home...');
  const html = await fetchHTML(BASE + '/');
  const $    = cheerio.load(html);

  const seen = new Map(); // id → url completa

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/excursion-\d+/.test(href)) return;
    const full = href.startsWith('http') ? href : `${BASE}/${href.replace(/^\//, '')}`;
    const m    = full.match(/excursion-(\d+)/);
    if (m && !seen.has(m[1])) seen.set(m[1], full.split('?')[0]);
  });

  console.log(`   → ${seen.size} excursiones encontradas`);
  return [...seen.values()];
}

// ─── Parser de precios ────────────────────────────────────────────────────────

function parsePrecioBlock(texto) {
  const precios = {};

  // Variante A: "doble o triple U$S NNN / PROMO ... U$S MMM"
  const dtMatch = texto.match(/doble\s+o\s+triple\s+U\$S\s*([\d.,]+)/i);
  if (dtMatch) {
    precios.doble = parseFloat(dtMatch[1].replace(',', '.'));
    const promoM  = texto.match(/(?:PROMO|CONTADO)[^\n]*U\$S\s*([\d.,]+)/i);
    if (promoM) precios.promo = parseFloat(promoM[1].replace(',', '.'));
  } else {
    // Variante B: cada base en línea propia con sus 2 precios (base + promo)
    const lineaDoble = texto.match(/BASE\s+DOBLE[^\n]*/i);
    if (lineaDoble) {
      const nums = [...lineaDoble[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.doble      = parseFloat(nums[0][1].replace(',', '.'));
      if (nums[1]) precios.promoDoble = parseFloat(nums[1][1].replace(',', '.'));
    }
    const lineaTriple = texto.match(/BASE\s+TRIPLE[^\n]*/i);
    if (lineaTriple) {
      const nums = [...lineaTriple[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.triple      = parseFloat(nums[0][1].replace(',', '.'));
      if (nums[1]) precios.promoTriple = parseFloat(nums[1][1].replace(',', '.'));
    }
    const lineaSingle = texto.match(/(?:HABITACION\s+)?SINGLE[^\n]*/i);
    if (lineaSingle) {
      const nums = [...lineaSingle[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.single      = parseFloat(nums[0][1].replace(',', '.'));
      if (nums[1]) precios.promoSingle = parseFloat(nums[1][1].replace(',', '.'));
    }
  }

  // Single como recargo % (cuando no hay monto fijo)
  if (!precios.single) {
    const pctM = texto.match(/SINGLE\s+([\d]+)\s*%\s*M[AÁ]S/i);
    if (pctM) precios.singleLabel = `Single: +${pctM[1]}%`;
  }

  // Butaca
  const butacaM = texto.match(/(?:COSTO\s+(?:DE\s+LA\s+)?)?BUTACA[:\s]+(?:U\$S\s*)?([\d.,]+)/i)
               || texto.match(/SOLO\s+ASIENTO[:\s]+(?:U\$S\s*)?([\d.,]+)/i);
  if (butacaM) precios.butaca = parseFloat(butacaM[1].replace(',', '.'));

  // Menor gratis
  const menorM = texto.match(
    /MENOR(?:ES)?\s+(?:HASTA|hasta)\s+(\d+)\s+[Aa][ÑñNn][Oo][Ss]?[^.]*(?:ES\s+NUESTRO\s+INVITADO|SIN\s+CARGO|GRATIS|FREE)/i
  );
  if (menorM) precios.menorGratis = `Menores hasta ${menorM[1]} años: invitado`;

  return precios;
}

// ─── Parser principal ────────────────────────────────────────────────────────

function parsePrograma(html, sourceUrl) {
  const $ = cheerio.load(html);
  $('nav, header, footer, script, style, noscript').remove();

  // ── ID ─────────────────────────────────────────────────────────────────────
  const idM    = sourceUrl.match(/excursion-(\d+)/);
  const rutaId = idM ? idM[1] : String(Date.now());
  const id     = `rutatur-${rutaId}`;

  // ── Título ─────────────────────────────────────────────────────────────────
  const tituloRaw = clean($('h2').first().text());
  if (!tituloRaw || tituloRaw.length < 3) return null;

  // ── Imagen ─────────────────────────────────────────────────────────────────
  let imagen = '';
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!imagen && src.includes('/usr/data/excursiones/')) {
      imagen = src.startsWith('http') ? src : `${BASE}${src}`;
    }
  });

  // ── Líneas de texto (nodos bloque, sin duplicar hijos) ─────────────────────
  const lineas = [];
  $('body').find('h2, h3, h4, h5, p, li').each((_, el) => {
    const txt = clean($(el).text());
    if (txt) lineas.push(txt);
  });
  const textoPlano = lineas.join('\n');

  // ── Duración ───────────────────────────────────────────────────────────────
  const diasM   = tituloRaw.match(/(\d+)\s*D[ií]as?/i) || textoPlano.match(/(\d+)\s*D[ií]as?\b/i);
  const nochesM = tituloRaw.match(/(\d+)\s*Noches?/i)  || textoPlano.match(/(\d+)\s*Noches?\b/i);
  const dias    = diasM   ? diasM[1]   : '';
  const noches  = nochesM ? nochesM[1] : '';
  const durStr  = dias ? `${dias} DÍAS${noches ? ` / ${noches} NOCHES` : ''}` : 'Consultar';

  // ── Título limpio (sin días/noches para los cards) ─────────────────────────
  const titulo = tituloRaw
    .replace(/\s*[-–]?\s*\d+\s*[Dd][ií][aá]s?\s*(?:[\/\s]*\d*\s*[Nn]oches?)?/g, '')
    .replace(/\s*[-–]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || tituloRaw;

  // ── Ciudades visitadas (highlights) ────────────────────────────────────────
  // Es la línea en cursiva con " - " que aparece antes del itinerario
  let ciudadesLinea = '';
  const itInicioIdx = lineas.findIndex(l => /^D[íi]a\s+01[\s\-–]/i.test(l));
  const buscarHasta = itInicioIdx !== -1 ? itInicioIdx : Math.min(12, lineas.length);
  for (let i = 0; i < buscarHasta; i++) {
    const l = lineas[i];
    if (
      l.includes(' - ') && l.length > 10 && l.length < 200 &&
      l !== tituloRaw && l !== titulo &&
      !l.match(/D[íi]a\s+\d+/i) &&
      !l.match(/Salida|HOTEL|COSTO|U\$S|SEGURO|BUTACA/i)
    ) { ciudadesLinea = l; break; }
  }

  // ── Itinerario ─────────────────────────────────────────────────────────────
  const itinerario = [];
  const inicioIdx  = lineas.findIndex(l => /^D[íi]a\s+01[\s\-–]/i.test(l));
  const finIdx     = lineas.findIndex(l => /HASTA LA PR[OÓ]XIMA EXCURSI[OÓ]N/i.test(l));

  if (inicioIdx !== -1 && finIdx !== -1) {
    let diaActual = null, lugActual = null, textosDia = [];

    const parseCabecera = (line) => {
      const m = line.match(/^(?:D[íi]a|DIAS?)\s+([\d\-]+)\s*[–\-]\s*(.+)/i);
      if (!m) return { diaLabel: line, lugar: line };
      const num   = m[1].includes('-') ? m[1] : m[1].padStart(2, '0');
      const lugar = clean(m[2].replace(/HASTA LA PR[OÓ]XIMA.*/i, ''));
      return { diaLabel: `DÍA ${num.toUpperCase()}`, lugar };
    };

    for (let i = inicioIdx; i <= finIdx; i++) {
      const line  = lineas[i];
      const isDia = /^D[íi]a\s+\d+[\s\-–]/i.test(line) || /^DIAS?\s+[\d\-]+[\s\-–]/i.test(line);
      const isFin = /HASTA LA PR[OÓ]XIMA EXCURSI[OÓ]N/i.test(line);

      if (isFin) {
        if (isDia) {
          // La línea es a la vez encabezado del último día y fin
          if (diaActual) itinerario.push({
            dia: diaActual, lugar: lugActual,
            detalle: textosDia.join(' ').trim(), first: false, last: false,
          });
          const { diaLabel, lugar } = parseCabecera(line);
          itinerario.push({ dia: diaLabel, lugar, detalle: '', first: false, last: true });
        } else if (diaActual) {
          // "HASTA LA PROXIMA" dentro del texto del último día
          const textoFin = clean(line.replace(/HASTA LA PR[OÓ]XIMA EXCURSI[OÓ]N[!¡]*/i, ''));
          if (textoFin) textosDia.push(textoFin);
          itinerario.push({
            dia: diaActual, lugar: lugActual,
            detalle: textosDia.join(' ').trim(), first: false, last: true,
          });
        }
        break;
      }

      if (isDia) {
        if (diaActual !== null) {
          itinerario.push({
            dia: diaActual, lugar: lugActual,
            detalle: textosDia.join(' ').trim(), first: false, last: false,
          });
        }
        const { diaLabel, lugar } = parseCabecera(line);
        diaActual = diaLabel;
        lugActual = lugar;
        textosDia = [];
      } else if (diaActual !== null) {
        textosDia.push(line);
      }
    }

    // Corregir first/last
    if (itinerario.length > 0) {
      for (let i = 0; i < itinerario.length; i++) {
        itinerario[i].first = i === 0;
        itinerario[i].last  = i === itinerario.length - 1;
      }
    }
  }

  // ── Highlights para los cards ──────────────────────────────────────────────
  const highlights = ciudadesLinea
    ? ciudadesLinea.split(' - ').map(c => `📍 ${c.trim()}`).slice(0, 6)
    : itinerario.slice(0, 6)
        .map(d => `📍 ${d.lugar}`)
        .filter(h => !/montevideo/i.test(h));

  // ── Salidas ────────────────────────────────────────────────────────────────
  const salidas = [];

  // Prioridad 1: "Salidas: TEXTO" (con s)
  const salidaTagM = textoPlano.match(/Salidas?:\s*([^\n]+)/i);
  if (salidaTagM) {
    const val = clean(salidaTagM[1]).replace(/\*+/g, '').trim();
    if (val.length > 3) salidas.push(val);
  }

  // Prioridad 2: "Salida DD de MES..." al pie (líneas <li>)
  const SALIDA_RX = /\*{0,3}\s*Salida\s+([^\n*]{5,80}(?:hs|Hs|HRS)?)/gi;
  let sm;
  while ((sm = SALIDA_RX.exec(textoPlano)) !== null) {
    const val = clean(sm[1]).replace(/\*+/g, '').trim();
    if (val.length > 3 && !salidas.some(s => s.toLowerCase() === val.toLowerCase())) {
      salidas.push(val);
    }
  }

  // ── Hoteles ────────────────────────────────────────────────────────────────
  const hoteles = [];
  const hotelIdx = lineas.findIndex(l => /^HOTEL:$/i.test(l.trim()));
  if (hotelIdx !== -1) {
    for (let i = hotelIdx + 1; i < lineas.length; i++) {
      const l = clean(lineas[i]);
      if (!l) continue;
      if (/Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA|U\$S\s+\d|^SALIDA\s+\d/i.test(l)) break;
      hoteles.push({ nombre: l.replace(/\*+/g, '').trim(), url: '' });
    }
  } else {
    // Fallback: líneas con nombre en mayúsculas + www. o estrellas
    for (const l of lineas) {
      if (/Plaza Cagancha|Pocitos|rutatur\.com$|Montevideo|Uruguay/i.test(l)) continue;
      if (l.match(/\*{2,}|www\.|\.com\.br/i) && l.match(/[A-Z]{4,}/)) {
        const parts  = l.split(/\s+(?=www\.)/);
        const nombre = parts[0].replace(/\*+/g, '').replace(/^HOTEL(ES)?:?\s*/i, '').trim();
        const url    = parts[1] || '';
        if (
          nombre.length > 2 && nombre.length < 80 &&
          !/RUTATUR|MONTEVIDEO|URUGUAY|CAGANCHA|POCITOS|BRASIL|ARGENTINA/i.test(nombre) &&
          !hoteles.some(h => h.nombre === nombre)
        ) hoteles.push({ nombre, url });
      }
    }
  }

  // ── Precios ────────────────────────────────────────────────────────────────
  const ps = textoPlano.search(/(?:Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA)/i);
  const pe = textoPlano.search(/Plaza de Cagancha/i);
  const precioBlock = ps !== -1
    ? textoPlano.slice(ps, pe !== -1 ? pe : undefined)
    : textoPlano;
  const precios = parsePrecioBlock(precioBlock);

  // ── Notas ──────────────────────────────────────────────────────────────────
  const notas = [];
  for (const line of lineas) {
    if (
      /menor|asiento|butaca|contado|promo|importante|políticas|cancelación|señ|free|invitado/i.test(line) &&
      line.length > 15 && line.length < 400 &&
      !/Plaza Cagancha|www\.rutatur|Pocitos|Montevideo/i.test(line)
    ) {
      const n = line.replace(/\*+/g, '').trim();
      if (!notas.includes(n)) notas.push(n);
    }
  }

  // ── Temporada ──────────────────────────────────────────────────────────────
  let temporada = '';
  const tempM = tituloRaw.match(/\b(verano|invierno|oto[ñn]o|primavera|aniversario|vacaciones)\b/i);
  if (tempM) {
    temporada = tempM[0].charAt(0).toUpperCase() + tempM[0].slice(1).toLowerCase();
  } else if (salidas.length > 0) {
    const mesM = salidas[0].match(
      /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)\b/i
    );
    if (mesM) {
      const anioM = salidas[0].match(/\b(202\d)\b/);
      temporada = mesM[0].charAt(0).toUpperCase() + mesM[0].slice(1).toLowerCase() +
                  (anioM ? ` ${anioM[0]}` : '');
    }
  }

  // ── Fechas para card ───────────────────────────────────────────────────────
  const fechas = [];
  if (salidas.length > 0) {
    fechas.push({ label: 'Salida', value: salidas[0].substring(0, 80), gold: true });
  }
  if (salidas.length > 1) {
    fechas.push({
      label: 'Otras salidas',
      value: salidas.slice(1, 4).join(' · ').substring(0, 80),
      gold: false,
    });
  }

  // ── Destino / país ─────────────────────────────────────────────────────────
  const destinoSlug = inferSlug(tituloRaw);

  return {
    id,
    rutaId,
    operador    : 'rutatur',
    sourceUrl,
    titulo      : tituloRaw,       // título completo (con días/noches) para la ficha
    subtitulo   : durStr,
    duracion    : durStr,
    destino     : titulo,          // título limpio para los cards
    destinoSlug,
    pais        : PAIS_MAP[destinoSlug]  || 'Otros',
    emoji       : EMOJI_MAP[destinoSlug] || '📍',
    imagen,
    highlights,
    fechas,
    salidas,
    itinerario,
    hoteles,
    precios,
    temporada,
    notas,
    updatedAt   : new Date().toISOString(),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function scrapeAll() {
  console.log('🚌 Scraper Rutatur v2 – BestWay Viajes\n');

  const result = {
    operador  : 'Rutatur',
    updatedAt : new Date().toISOString(),
    programas : [],
  };

  // 1. Descubrir URLs desde la home
  let urls = [];
  try {
    urls = await discoverUrls();
    if (!urls.length) throw new Error('0 URLs encontradas en la home');
  } catch (e) {
    console.error('❌ Error en auto-discovery:', e.message);
    process.exit(1);
  }

  // 2. Scrape de cada programa
  let errores = 0;
  for (const url of urls) {
    await sleep(DELAY_MS);
    const idM = url.match(/excursion-(\d+)/);
    console.log(`\n📄 [${idM?.[1] || '?'}] ${url}`);
    try {
      const html = await fetchHTML(url);
      const prog = parsePrograma(html, url);
      if (!prog?.titulo) { console.warn('   ⚠ Sin datos'); continue; }
      result.programas.push(prog);
      const p = prog.precios;
      const precioLabel = p.doble
        ? `U$S ${p.doble}${p.promo ? ` / promo ${p.promo}` : p.promoDoble ? ` / promo ${p.promoDoble}` : ''}`
        : '—';
      console.log(
        `   ✅ ${prog.itinerario.length} días | ` +
        `${prog.hoteles[0]?.nombre?.substring(0, 35) || '—'} | ` +
        `${precioLabel}`
      );
    } catch (e) {
      console.warn(`   ❌ ${e.message}`);
      errores++;
    }
  }

  if (!result.programas.length) {
    console.error('\n❌ Sin programas obtenidos. JSON no sobreescrito.');
    process.exit(1);
  }

  result.updatedAt = new Date().toISOString();

  // 3. Guardar JSON
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ ${result.programas.length} programas → ${OUT_PATH}`);
  if (errores) console.warn(`⚠  ${errores} programas fallaron`);
}

scrapeAll().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
