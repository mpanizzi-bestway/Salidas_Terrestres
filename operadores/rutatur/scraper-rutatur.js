/**
 * scraper-rutatur.js - BestWay Viajes
 * v2.2 — Mayo 2026
 *
 * CAMBIOS respecto a v2.1:
 *  ✅ HIGHLIGHTS: fuente = itinerario[].lugar (no texto libre)
 *     Dedup por más corto (si uno contiene al otro, queda el más corto)
 *     Excluye MONTEVIDEO y variantes
 *  ✅ HOTELES: parser unificado con 5 patrones HTML reales
 *     Objeto { ciudad, nombre, estrellas, url } por hotel
 *  ✅ PRECIOS: agrega /PRECIO\s+POR\s+PERSONA/i como inicio de bloque
 *     Precio principal = primer U$S del bloque (precios.doble)
 *     BUTACA / SOLO ASIENTO → notas[] (ya no en precios)
 *     MENOR HASTA → notas[] (ya no en precios)
 *     PROMO/CONTADO/TRANSFERENCIA → precios.promo { monto, condicion }
 *     singleLabel (%) permanece en precios, se renderiza bajo la grilla
 *  ✅ SALIDAS: captura adicional desde <div class="descr">
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
  [/rio de janeiro|noche.*nostalgia.*rio|rio.*nostalgia/i,            'rio'          ],
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

async function discoverUrls() {
  console.log('🔍 Descubriendo excursiones desde la home...');
  const html = await fetchHTML(BASE + '/');
  const $    = cheerio.load(html);

  const seen = new Map();

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

// ─── Highlights: dedup por más corto ─────────────────────────────────────────

/**
 * Dado un array de strings, elimina duplicados por contenido parcial:
 * si uno contiene al otro, queda el MÁS CORTO (nombre base sin hotel).
 * El primero que aparece tiene prioridad salvo que llegue uno más corto.
 */
function deduplicarHighlights(lugares) {
  const result = [];
  for (const lugar of lugares) {
    // ¿Hay un existente que ya contenga al nuevo (nuevo es más corto)?
    const idxMasLargo = result.findIndex(r => r.includes(lugar));
    if (idxMasLargo !== -1) {
      result[idxMasLargo] = lugar; // reemplazar por el más corto
      continue;
    }
    // ¿El nuevo contiene a algún existente (el existente ya es más corto)?
    if (result.some(r => lugar.includes(r))) continue;
    // Sin solapamiento → agregar
    result.push(lugar);
  }
  return result;
}

// ─── Parser de hoteles ────────────────────────────────────────────────────────

const HOTEL_EXCLUIR = /^HOTEL(?:ES)?:$|SEGURO DE ASISTENCIA|SEGURO INCLUIDO|COSTO POR PERSONA|PRECIO POR PERSONA|BASE DOBLE|BASE TRIPLE|HABITACION SINGLE|U\$S\s+\d|BUTACA|MENOR|Plaza Cagancha|Pocitos|rutatur\.com|Montevideo|Uruguay/i;

/**
 * Parsea una línea suelta de hotel y retorna { ciudad, nombre, estrellas, url }
 * Soporta los 5 patrones reales del HTML de Rutatur.
 */
function parseHotelLinea(lineaRaw) {
  let linea = clean(lineaRaw);

  // Descartar líneas de encabezado o excluidas
  if (!linea || HOTEL_EXCLUIR.test(linea)) return null;

  let ciudad = '', nombre = '', estrellas = '', url = '';

  // 1. Extraer URL (www.xxx)
  const urlM = linea.match(/www\.\S+/i);
  if (urlM) {
    url   = urlM[0].replace(/[,;.]+$/, '');
    linea = linea.replace(urlM[0], '').trim();
  }

  // 2. Extraer estrellas: "****" o "3***" o "4*"
  const estreM = linea.match(/\d?\*{1,5}/);
  if (estreM) {
    estrellas = estreM[0];
    linea     = linea.replace(estreM[0], '').trim();
  }

  // 3. Limpiar separadores sueltos al final
  linea = linea.replace(/[-:.\s]+$/, '').trim();
  // Limpiar prefijo "HOTEL:" o "HOTELES:"
  linea = linea.replace(/^HOTEL(?:ES)?:?\s*/i, '').trim();

  if (!linea && !url) return null;
  if (!linea) { nombre = url; return { ciudad, nombre, estrellas, url }; }

  // 4. Separar ciudad de nombre
  // Prioridad 1: "CIUDAD: NOMBRE" (dos puntos explícitos)
  const dosPuntosM = linea.match(/^([^:]{2,30}):\s*(.+)$/);
  if (dosPuntosM) {
    ciudad = dosPuntosM[1].trim();
    nombre = dosPuntosM[2].trim();
  }
  // Prioridad 2: "TEXTO - TEXTO" (guión como separador ciudad/nombre)
  else if (linea.includes('-')) {
    const partes = linea.split('-').map(p => p.trim()).filter(Boolean);
    if (partes.length >= 2) {
      // Heurística: la parte más corta suele ser la ciudad
      if (partes[0].length <= partes[partes.length - 1].length) {
        ciudad = partes[0];
        nombre = partes.slice(1).join('-').trim();
      } else {
        nombre = partes[0];
        ciudad = partes.slice(1).join('-').trim();
      }
    } else {
      nombre = linea;
    }
  }
  // Prioridad 3: "CIUDAD. NOMBRE" (punto como separador)
  else if (linea.includes('.') && !/^www/i.test(linea)) {
    const dotIdx = linea.indexOf('.');
    ciudad = linea.slice(0, dotIdx).trim();
    nombre = linea.slice(dotIdx + 1).trim();
  }
  // Sin separador → todo es nombre
  else {
    nombre = linea;
  }

  // 5. Limpiar asteriscos residuales
  nombre = nombre.replace(/\*+/g, '').trim();
  ciudad = ciudad.replace(/\*+/g, '').trim();

  // Descartar si el nombre resultante es demasiado largo (basura) o vacío
  if (!nombre && !url) return null;
  if (nombre.length > 120) return null;

  return { ciudad, nombre, estrellas, url };
}

/**
 * Extrae todos los hoteles del HTML parseado.
 * Detecta el bloque por /^HOTEL(?:ES)?:/i y lo delimita con marcadores de precio.
 * Fallback: busca líneas con ★★ o www. + mayúsculas.
 */
function extraerHoteles($, lineas) {
  const hoteles  = [];
  const FIN_BLOQUE = /Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA|PRECIO\s+POR\s+PERSONA|^SALIDA\s+\d/i;

  // ── Ruta 1: marcador explícito "HOTEL:" o "HOTELES:" ─────────────────────
  const hotelIdx = lineas.findIndex(l => /^HOTEL(?:ES)?:\s*$/i.test(l.trim()));

  if (hotelIdx !== -1) {
    for (let i = hotelIdx + 1; i < lineas.length; i++) {
      const l = clean(lineas[i]);
      if (!l) continue;
      if (FIN_BLOQUE.test(l)) break;
      const h = parseHotelLinea(l);
      if (h && !hoteles.some(x => x.nombre === h.nombre && x.url === h.url)) {
        hoteles.push(h);
      }
    }
    if (hoteles.length > 0) return hoteles;
  }

  // ── Ruta 1b: "HOTELES: lista en la misma línea" (Patrón A)
  // Ej: "HOTELES:\nGUARATUBA: SPAZIO MARINE www.xxx\n..."
  // Cheerio: recorre <p> que empiezan con HOTEL
  $('p, div').each((_, el) => {
    const txt = $(el).text();
    if (!/^HOTEL(?:ES)?:/i.test(clean(txt))) return;
    // Dividir por <br> internos
    $(el).find('br').replaceWith('\n');
    const subLineas = $(el).text().split('\n');
    for (const sub of subLineas) {
      const h = parseHotelLinea(sub);
      if (h && !hoteles.some(x => x.nombre === h.nombre && x.url === h.url)) {
        hoteles.push(h);
      }
    }
  });
  if (hoteles.length > 0) return hoteles;

  // ── Ruta 2: fallback heurístico ─────────────────────────────────────────
  for (const l of lineas) {
    if (HOTEL_EXCLUIR.test(l)) continue;
    if (l.match(/\*{2,}|www\.|\.com\.br|\.com\.ar/i) && l.match(/[A-Z]{4,}/)) {
      const h = parseHotelLinea(l);
      if (h && !hoteles.some(x => x.nombre === h.nombre && x.url === h.url)) {
        hoteles.push(h);
      }
    }
  }

  return hoteles;
}

// ─── Parser de precios ────────────────────────────────────────────────────────

function parsePrecioBlock(texto, notas) {
  const precios = {};

  // ── Precio principal: PRIMER U$S del bloque ────────────────────────────────
  const primerM = texto.match(/U\$S\s*([\d.,]{1,6})/i);
  if (primerM) {
    precios.doble = parseFloat(
      primerM[1].replace(/[.,](?=\d{3})/g, '').replace(',', '.')
    );
  }

  // ── PROMO / CONTADO / TRANSFERENCIA → precios.promo ──────────────────────
  // Disparador: cualquiera de PROMO, CONTADO, TRANSFERENCIA
  // Formato esperado: "... - PROMO PAGO CONTADO U$S 999" o similar
  const promoM = texto.match(
    /[-–]\s*((PROMO|CONTADO|TRANSFERENCIA)[^\n]*?U\$S\s*([\d.,]{1,6})[\*]*)/i
  );
  if (promoM) {
    const montoStr   = promoM[3];
    const condicion  = promoM[1]
      .replace(/U\$S[\s\d.,]+[\*]*/i, '')
      .replace(/\*/g, '')
      .trim();
    precios.promo = {
      monto    : parseFloat(montoStr.replace(/[.,](?=\d{3})/g, '').replace(',', '.')),
      condicion: condicion,
    };
  }

  // ── Single con porcentaje → precios.singleLabel (va bajo la grilla) ───────
  const pctM = texto.match(/SINGLE[^%\n]{0,30}([\d]+)\s*%/i);
  if (pctM) precios.singleLabel = `Single: +${pctM[1]}% adicional`;

  // ── Butaca / Solo asiento → NOTAS (ya no en precios) ─────────────────────
  const butacaM =
    texto.match(/(?:COSTO\s+(?:DE\s+LA\s+)?)?BUTACA[:\s]+(?:U\$S\s*)?([\d.,]+)/i) ||
    texto.match(/SOLO\s+ASIENTO[:\s]+(?:U\$S\s*)?([\d.,]+)/i);
  if (butacaM) {
    const monto = parseFloat(butacaM[1].replace(',', '.'));
    notas.push(`Butaca / Solo asiento: U$S ${monto.toLocaleString('es-UY')}`);
  }

  // ── Menor gratis → NOTAS (ya no en precios) ───────────────────────────────
  const menorM = texto.match(
    /MENOR(?:ES)?\s+(?:HASTA|hasta)\s+(\d+)\s+[Aa][ÑñNn][Oo][Ss]?[^.]*(?:ES\s+NUESTRO\s+INVITADO|SIN\s+CARGO|GRATIS|FREE)/i
  );
  if (menorM) {
    notas.push(`Menores hasta ${menorM[1]} años: invitado`);
  }

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

  // ── Líneas de texto ────────────────────────────────────────────────────────
  const lineas = [];
  $('body').find('h2, h3, h4, h5, p, li, strong').each((_, el) => {
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

  // ── Título limpio ──────────────────────────────────────────────────────────
  const titulo = tituloRaw
    .replace(/\s*[-–]?\s*\d+\s*[Dd][ií][aá]s?\s*(?:[\/\s]*\d*\s*[Nn]oches?)?/g, '')
    .replace(/\s*[-–]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || tituloRaw;

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
          if (diaActual) itinerario.push({
            dia: diaActual, lugar: lugActual,
            detalle: textosDia.join(' ').trim(), first: false, last: false,
          });
          const { diaLabel, lugar } = parseCabecera(line);
          itinerario.push({ dia: diaLabel, lugar, detalle: '', first: false, last: true });
        } else if (diaActual) {
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

    if (itinerario.length > 0) {
      for (let i = 0; i < itinerario.length; i++) {
        itinerario[i].first = i === 0;
        itinerario[i].last  = i === itinerario.length - 1;
      }
    }
  }

  // ── Highlights: desde itinerario (NO desde texto libre) ───────────────────
  // Fuente: campo .lugar de cada entrada del itinerario ya parseado
  // Excluir MONTEVIDEO y variantes cercanas
  // Dedup: si uno contiene al otro, queda el más corto
  const lugaresRaw = itinerario
    .map(d => d.lugar.trim())
    .filter(l => l && !/\bMONTEVIDEO\b/i.test(l));

  const highlights = deduplicarHighlights(lugaresRaw)
    .slice(0, 6)
    .map(l => `📍 ${l}`);

  // ── Salidas ────────────────────────────────────────────────────────────────
  const salidas = [];

  // Fuente 0: <div class="descr"> (nueva, mayor prioridad)
  $('div.descr').each((_, el) => {
    const txt = clean($(el).text());
    if (/^salida\s+/i.test(txt) && txt.length > 8) {
      const val = txt.replace(/\*+/g, '').trim();
      if (!salidas.some(s => s.toLowerCase() === val.toLowerCase())) {
        salidas.push(val);
      }
    }
  });

  // Fuente 1: etiqueta "Salidas?: valor"
  const salidaTagM = textoPlano.match(/Salidas?:\s*([^\n]+)/i);
  if (salidaTagM) {
    const val = clean(salidaTagM[1]).replace(/\*+/g, '').trim();
    if (val.length > 3 && !salidas.some(s => s.toLowerCase() === val.toLowerCase())) {
      salidas.push(val);
    }
  }

  // Fuente 2: regex global "Salida DD de MES..."
  const SALIDA_RX = /\*{0,3}\s*Salida\s+([^\n*]{5,80}(?:hs|Hs|HRS)?)/gi;
  let sm;
  while ((sm = SALIDA_RX.exec(textoPlano)) !== null) {
    const val = clean(sm[1]).replace(/\*+/g, '').trim();
    if (val.length > 3 && !salidas.some(s => s.toLowerCase() === val.toLowerCase())) {
      salidas.push(val);
    }
  }

  // ── Hoteles ────────────────────────────────────────────────────────────────
  const hoteles = extraerHoteles($, lineas);

  // ── Notas (se pasa array mutable a parsePrecioBlock) ──────────────────────
  const notas = [];

  // Recolectar notas por palabras clave ANTES de parsear precios
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

  // ── Precios ────────────────────────────────────────────────────────────────
  // Bloque delimitado por inicio y fin
  const INICIO_PRECIOS = /Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA|PRECIO\s+POR\s+PERSONA/i;
  const FIN_PRECIOS    = /Plaza de Cagancha/i;

  const ps = textoPlano.search(INICIO_PRECIOS);
  const pe = textoPlano.search(FIN_PRECIOS);
  const precioBlock = ps !== -1
    ? textoPlano.slice(ps, pe !== -1 ? pe : undefined)
    : textoPlano;

  // parsePrecioBlock puede agregar a notas[] (butaca, menor)
  const precios = parsePrecioBlock(precioBlock, notas);

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
    titulo      : tituloRaw,
    subtitulo   : durStr,
    duracion    : durStr,
    destino     : titulo,
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
  console.log('🚌 Scraper Rutatur v2.2 – BestWay Viajes\n');

  const result = {
    operador  : 'Rutatur',
    updatedAt : new Date().toISOString(),
    programas : [],
  };

  let urls = [];
  try {
    urls = await discoverUrls();
    if (!urls.length) throw new Error('0 URLs encontradas en la home');
  } catch (e) {
    console.error('❌ Error en auto-discovery:', e.message);
    process.exit(1);
  }

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
        ? `U$S ${p.doble}${p.promo ? ` / promo ${p.promo.monto}` : ''}`
        : '—';
      console.log(
        `   ✅ ${prog.itinerario.length} días | ` +
        `HL: [${prog.highlights.map(h => h.replace('📍 ','')).join(', ')}] | ` +
        `Hoteles: ${prog.hoteles.length} | ` +
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
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ ${result.programas.length} programas → ${OUT_PATH}`);
  if (errores) console.warn(`⚠  ${errores} programas fallaron`);
}

scrapeAll().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
