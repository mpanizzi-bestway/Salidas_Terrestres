/**
 * scraper-rutatur.js - BestWay Viajes
 * v2.3 — Mayo 2026
 *
 * CAMBIOS respecto a v2.1:
 *  ✅ HIGHLIGHTS: extraídos del itinerario (etiquetas <strong>DÍA XX – LUGAR</strong>),
 *     sin "DÍA XX –", sin duplicados por coincidencia parcial, sin Montevideo.
 *  ✅ HOTELES: nuevo parser robusto para todos los formatos encontrados en producción
 *     (CIUDAD: HOTEL url / HOTEL: url / HOTEL nombre url / formato en <strong>).
 *  ✅ PRECIOS: bloque inicio extendido (+ "PRECIO POR PERSONA"); fin = token U$S/USD
 *     seguido de hasta 5 chars numéricos; SINGLE+% → bajo precio; BUTACA y MENOR → notas.
 *  ✅ PRECIOS: nuevo sub-bloque PROMO (desplegable) desde /PROMO/i hasta fin de elemento.
 *  ✅ SALIDAS: captura adicional desde <div class="descr">Salida DD Mes YYYY - Hora HH:MM</div>.
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
 *        hoteles[{ ciudad?, nombre, url? }],
 *        precios{
 *          doble?, triple?, promo?, promoDoble?, promoTriple?,
 *          single?, promoSingle?, singleLabel?,
 *          butaca?, menorGratis?,
 *          promoTexto?   ← texto completo del bloque PROMO (para desplegable)
 *        },
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

// ─── Highlights desde itinerario ──────────────────────────────────────────────
/**
 * Extrae los lugares únicos del itinerario a partir de las etiquetas <strong>
 * que contienen "DÍA XX – LUGAR". Elimina el prefijo "DÍA XX –", elimina
 * Montevideo y variantes, y deduplica por coincidencia parcial (si un nombre
 * es subcadena de otro ya existente, o viceversa, conserva sólo el primero).
 */
function extractHighlightsFromHTML($) {
  const lugares = [];

  // Capturar de <strong> que tengan el patrón "D[ÍI]A \d+ – TEXTO"
  $('strong').each((_, el) => {
    const txt = clean($(el).text());
    // Coincide con "DÍA 01 – LUGAR" o "DIAS 01-03 – LUGAR" etc.
    const m = txt.match(/^D[IÍ]A[S]?\s+[\d\-]+\s*[–\-]\s*(.+)/i);
    if (!m) return;
    const lugar = clean(m[1]);
    if (!lugar || lugar.length < 2) return;

    // Excluir Montevideo y variantes
    if (/^MONTEVIDEO\b/i.test(lugar)) return;
    if (/^HASTA LA PR[OÓ]XIMA/i.test(lugar)) return;

    // Deduplicar por coincidencia parcial:
    // Si ya existe uno que contenga este nuevo, o este nuevo contiene uno ya existente → skip
    const yaExiste = lugares.some(l => {
      const lUp  = l.toUpperCase();
      const nUp  = lugar.toUpperCase();
      return lUp === nUp || lUp.includes(nUp) || nUp.includes(lUp);
    });
    if (!yaExiste) lugares.push(lugar);
  });

  return lugares.slice(0, 6).map(l => `📍 ${l}`);
}

// ─── Parser de hoteles ────────────────────────────────────────────────────────
/**
 * Formatos observados en producción:
 *
 * 1) HOTELES:\n  CIUDAD: NOMBRE www.url.com.br\n  CIUDAD: NOMBRE www.url.com.br
 * 2) HOTEL: www.url.com.br   (hotel sin nombre explícito, sólo URL)
 * 3) HOTEL: CIUDAD. NOMBRE**** www.url.com.br
 * 4) <strong>HOTELES:</strong> <strong>NOMBRE 3*** www.url.com.ar</strong>
 * 5) CIUDAD - NOMBRE www.url.com.br  (separado por " - ")
 * 6) CIUDAD/CIUDAD2 - NOMBRE www.url.com.br
 * 7) NOMBRE (sin URL, sin ciudad)
 *
 * Devuelve array de { ciudad?, nombre, url? }
 */
function parseHoteles($) {
  const EXCLUIR_HOTEL = /SEGURO\s+DE\s+ASISTENCIA|SEGURO\s+INCLUIDO|COSTO\s+POR\s+PERSONA|BASE\s+DOBLE|BASE\s+TRIPLE|HABITACION\s+SINGLE|PRECIO\s+POR\s+PERSONA|Valor\s+de\s+la\s+excursi/i;
  const FOOTER_EXCLUIR = /Plaza\s+Ca[gz]ancha|Pocitos|rutatur\.com|Montevideo\s*[\d,]/i;

  // Regex para URL de hotel
  const URL_RX = /(?:https?:\/\/)?(?:www\.)?[\w\-]+\.(?:com\.br|com\.ar|com\.uy|com|net|org)(?:\/\S*)?/i;

  const hoteles = [];
  const seen    = new Set();   // deduplicación por nombre normalizado

  function addHotel(ciudad, nombre, url) {
    nombre = nombre.replace(/\*+/g, '').replace(/^\s*HOTEL(?:ES)?:?\s*/i, '').trim();
    nombre = clean(nombre);
    if (!nombre || nombre.length < 2 || nombre.length > 120) return;
    if (EXCLUIR_HOTEL.test(nombre) || FOOTER_EXCLUIR.test(nombre)) return;
    // Ignorar si es sólo una URL
    if (URL_RX.test(nombre) && nombre.split(/\s+/).length < 2) return;
    const key = nombre.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    const entry = { nombre };
    if (ciudad) entry.ciudad = clean(ciudad);
    if (url) entry.url = url.trim().replace(/^https?:\/\//i, 'https://');
    hoteles.push(entry);
  }

  // ── Estrategia 1: buscar nodo que empiece por "HOTEL" (marcador explícito) ──
  // Recorrer todos los nodos de texto y <p>/<strong>
  const bloques = [];  // pares { tipo, texto, htmlNodo }

  $('p, li, div').each((_, el) => {
    const html = $(el).html() || '';
    const txt  = clean($(el).text());
    if (/^HOTEL(?:ES)?[:\s]/i.test(txt) || txt === 'HOTELES:' || txt === 'HOTEL:') {
      bloques.push({ el, txt, html });
    }
  });

  // Si encontramos bloques con marcador "HOTEL"
  for (const { el, html } of bloques) {
    // Procesamos líneas dentro del bloque (separadas por <br>)
    // Reemplazamos <br> por \n para separar
    const rawHtml = html.replace(/<br\s*\/?>/gi, '\n');
    const $tmp    = cheerio.load(rawHtml);
    const lineas  = $tmp.root().text().split('\n').map(clean).filter(Boolean);

    let esHotelesGlobal = false;   // primer token es "HOTELES:" sin ciudad

    for (let i = 0; i < lineas.length; i++) {
      const linea = lineas[i];
      if (EXCLUIR_HOTEL.test(linea) || FOOTER_EXCLUIR.test(linea)) continue;

      // Línea marcador puro → saltar
      if (/^HOTEL(?:ES)?:?$/i.test(linea)) { esHotelesGlobal = true; continue; }

      // Extraer URL si la hay (puede estar al final de la línea o incrustada)
      let urlEncontrada = '';
      const urlM = linea.match(URL_RX);
      if (urlM) urlEncontrada = urlM[0];

      // Quitar la URL del texto para procesar el nombre/ciudad
      const sinUrl = clean(linea.replace(URL_RX, ''));

      // Formato: "CIUDAD: NOMBRE" o "CIUDAD - NOMBRE" o "CIUDAD/CIUDAD2 - NOMBRE"
      //  → separador es ":" o " - "
      const sepM = sinUrl.match(/^([A-ZÁÉÍÓÚÑÜ][^:\-]{1,40})\s*[:]\s*(.+)/) ||
                   sinUrl.match(/^([A-ZÁÉÍÓÚÑÜ][^:\-]{1,40})\s+\-\s+(.+)/);

      if (sepM) {
        const ciudad = sepM[1].trim();
        const nombre = sepM[2].trim();
        // Si "ciudad" parece ser prefijo "HOTEL" o "HOTELES" → sin ciudad
        if (/^HOTEL(?:ES)?$/i.test(ciudad)) {
          addHotel('', nombre, urlEncontrada);
        } else {
          addHotel(ciudad, nombre, urlEncontrada);
        }
      } else if (sinUrl) {
        // Sin separador → sólo nombre (y ciudad vacía)
        // Quitar prefijo "HOTEL:" residual
        const nombre = sinUrl.replace(/^HOTEL(?:ES)?:?\s*/i, '').trim();
        addHotel('', nombre, urlEncontrada);
      } else if (urlEncontrada) {
        // Sólo URL sin nombre textual
        addHotel('', urlEncontrada, urlEncontrada);
      }
    }
  }

  // ── Estrategia 2 (fallback): líneas con www. o .com.br fuera de bloque HOTEL ──
  if (!hoteles.length) {
    $('p, li').each((_, el) => {
      const txt = clean($(el).text());
      if (EXCLUIR_HOTEL.test(txt) || FOOTER_EXCLUIR.test(txt)) return;
      if (!URL_RX.test(txt) && !txt.match(/\*{2,}/)) return;
      if (txt.match(/^D[IÍ]A\s+\d+/i)) return;

      const urlM = txt.match(URL_RX);
      const url  = urlM ? urlM[0] : '';
      const sinUrl = clean(txt.replace(URL_RX, '').replace(/^HOTEL(?:ES)?:?\s*/i, ''));
      const sepM = sinUrl.match(/^([A-ZÁÉÍÓÚÑÜ][^:\-]{1,40})\s*[:]\s*(.+)/) ||
                   sinUrl.match(/^([A-ZÁÉÍÓÚÑÜ][^:\-]{1,40})\s+\-\s+(.+)/);
      if (sepM) {
        addHotel(sepM[1], sepM[2], url);
      } else if (sinUrl) {
        addHotel('', sinUrl, url);
      }
    });
  }

  return hoteles;
}

// ─── Parser de precios ────────────────────────────────────────────────────────
/**
 * INICIO bloque: /Valor de la excursi[oó]n/i | /COSTO\s+POR\s+PERSONA/i | /PRECIO\s+POR\s+PERSONA/i
 * FIN bloque precios base: cuando se encuentre U$S/USD/U$S seguido de máx 5 chars de precio.
 *   Se toman TODOS los tokens U$S/USD + número en el bloque.
 * SINGLE + %  → singleLabel (va bajo precio, NO en notas)
 * BUTACA/SOLO ASIENTO → notas
 * MENOR HASTA \d AÑOS → notas
 *
 * PROMO: sub-bloque desde /PROMO/i hasta fin del elemento HTML (para desplegable).
 *   Se guarda como precios.promoTexto (string limpio).
 */
function parsePrecioBlock(texto, htmlBloque) {
  const precios = {};

  // ── Localizar bloque base ──────────────────────────────────────────────────
  const inicioRx = /(?:Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA|PRECIO\s+POR\s+PERSONA)/i;
  const ps = texto.search(inicioRx);
  const bloque = ps !== -1 ? texto.slice(ps) : texto;

  // ── Extraer todos los precios U$S/USD ──────────────────────────────────────
  // Patrón: U$S o USD o U$S seguido de espacio opcional y 3-5 dígitos (con posible . o , separador)
  const PRECIO_RX = /U\$S\s*([\d]{1,2}[.,\d]{0,4})/gi;
  const todosPrecios = [];
  let pm;
  while ((pm = PRECIO_RX.exec(bloque)) !== null) {
    const val = parseFloat(pm[1].replace(/\./g, '').replace(',', '.'));
    if (!isNaN(val) && val > 0) todosPrecios.push(val);
  }

  // Variante A: "doble o triple U$S NNN"
  const dtMatch = bloque.match(/doble\s+o\s+triple\s+U\$S\s*([\d.,]+)/i);
  if (dtMatch) {
    precios.doble = parseFloat(dtMatch[1].replace(',', '.'));
    // Segundo precio del mismo bloque (si existe) → promo
    if (todosPrecios.length >= 2) {
      precios.promo = todosPrecios[todosPrecios.length - 1];
    }
  } else {
    // Variante B: BASE DOBLE / BASE TRIPLE en líneas separadas
    const lineaDoble = bloque.match(/BASE\s+DOBLE[^\n]*/i);
    if (lineaDoble) {
      const nums = [...lineaDoble[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.doble      = parseFloat(nums[0][1].replace(',', '.'));
      if (nums[1]) precios.promoDoble = parseFloat(nums[1][1].replace(',', '.'));
    }
    const lineaTriple = bloque.match(/BASE\s+TRIPLE[^\n]*/i);
    if (lineaTriple) {
      const nums = [...lineaTriple[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.triple      = parseFloat(nums[0][1].replace(',', '.'));
      if (nums[1]) precios.promoTriple = parseFloat(nums[1][1].replace(',', '.'));
    }

    // Single con precio fijo: SOLO buscar ANTES del bloque PROMO
    // (evita que "Solo asiento, menores...: U$S 259" se confunda con habitacion single)
    const promoStartIdx = bloque.search(/\bPROMO\b/i);
    const bloquePrePromo = promoStartIdx > 0 ? bloque.slice(0, promoStartIdx) : bloque;
    const lineaSingle = bloquePrePromo.match(/(?:HABITACION\s+)?SINGLE[^\n]*/i);
    if (lineaSingle) {
      const nums = [...lineaSingle[0].matchAll(/U\$S\s*([\d.,]+)/gi)];
      if (nums[0]) precios.single      = parseFloat(nums[0][1].replace(',', '.'));
      if (nums[1]) precios.promoSingle = parseFloat(nums[1][1].replace(',', '.'));
    }

    // Fallback: si no se detectó precio base, usar primer U$S del bloque
    // NO asignar promo desde fallback (evita confundir precio asiento con promo)
    if (!precios.doble && !precios.triple && todosPrecios.length > 0) {
      precios.doble = todosPrecios[0];
      // Solo promo si hay exactamente 2 precios y el 2do es menor (descuento real)
      if (todosPrecios.length === 2 && todosPrecios[1] < todosPrecios[0]) {
        precios.promo = todosPrecios[1];
      }
    }
  }

  // ── Single como recargo % (va BAJO EL PRECIO, no en notas) ────────────────
  if (!precios.single && !precios.singleLabel) {
    const singleLineM = bloque.match(/(?:HABITACION\s+)?SINGLE[^\n]{0,120}/i);
    if (singleLineM) {
      const singleLine = singleLineM[0].trim();
      const pctM = singleLine.match(/([\d]+)\s*%\s*(?:M[AÁ]S|ADICIONAL|EXTRA)/i);
      if (pctM) {
        precios.singleLabel = `Habitación Single: +${pctM[1]}% adicional`;
      } else {
        // Edge case: U$S sin haberlo capturado antes
        const usdM = singleLine.match(/U\$S\s*([\d.,]+)/i);
        if (usdM) precios.single = parseFloat(usdM[1].replace(',', '.'));
      }
    }
  }

  // ── Butaca/Solo asiento → notas ──────────────────────────────────────────────
  // Captura la línea completa (incluyendo variante "- Solo asiento, (menores...): U$S 259")
  const butacaM = bloque.match(/(?:[-\u2013*]\s*)?(?:COSTO\s+(?:DE\s+LA\s+)?)?BUTACA[^\n]{0,120}/i)
               || bloque.match(/(?:[-\u2013*]\s*)?SOLO\s+ASIENTO[^\n]{0,120}/i);
  if (butacaM) {
    const usdM = butacaM[0].match(/U\$S\s*([\d.,]+)/i);
    if (usdM) precios.butaca = parseFloat(usdM[1].replace(',', '.'));
    precios._butacaNota = butacaM[0].replace(/^[-\u2013*\s]+/, '').trim();
  }

  // ── Menor gratis → notas ───────────────────────────────────────────────────
  const menorM = bloque.match(
    /MENOR(?:ES)?\s+(?:HASTA|hasta)\s+(\d+)\s+[Aa][ÑñNn][Oo][Ss]?[^.]{0,60}(?:ES\s+NUESTRO\s+INVITADO|SIN\s+CARGO|GRATIS|FREE)/i
  );
  if (menorM) {
    precios.menorGratis  = `Menores hasta ${menorM[1]} años: invitado`;
    precios._menorNota   = menorM[0].trim();  // para agregar a notas
  }

  // ── Sub-bloque PROMO (desplegable) ─────────────────────────────────────────
  // Buscar desde /PROMO/i en el texto del bloque hasta el fin del elemento
  const promoIdx = bloque.search(/PROMO/i);
  if (promoIdx !== -1) {
    // Limpiar y guardar el texto completo del bloque PROMO
    let promoText = clean(bloque.slice(promoIdx));
    // Quitar footer si lo hubiera
    const footerM = promoText.search(/Plaza\s+Ca[gz]ancha|rutatur\.com/i);
    if (footerM !== -1) promoText = promoText.slice(0, footerM).trim();
    if (promoText.length > 5) {
      precios.promoTexto = promoText;
    }
  }

  return precios;
}

// ─── Parser principal ────────────────────────────────────────────────────────

function parsePrograma(html, sourceUrl) {
  const $ = cheerio.load(html);

  // ── ID ─────────────────────────────────────────────────────────────────────
  const idM    = sourceUrl.match(/excursion-(\d+)/);
  const rutaId = idM ? idM[1] : String(Date.now());
  const id     = `rutatur-${rutaId}`;

  // ── Título ─────────────────────────────────────────────────────────────────
  $('nav, header, footer, script, style, noscript').remove();
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

    // Corregir first/last
    if (itinerario.length > 0) {
      for (let i = 0; i < itinerario.length; i++) {
        itinerario[i].first = i === 0;
        itinerario[i].last  = i === itinerario.length - 1;
      }
    }
  }

  // ── Highlights (desde <strong> del HTML, no del texto plano) ──────────────
  const highlights = extractHighlightsFromHTML($);
  // Fallback: si no se encontraron <strong> con patrón DÍA, usar itinerario
  const highlightsFinal = highlights.length > 0
    ? highlights
    : itinerario
        .filter(d => !/^MONTEVIDEO\b/i.test(d.lugar))
        .slice(0, 6)
        .map(d => `📍 ${d.lugar}`);

  // ── Hoteles ────────────────────────────────────────────────────────────────
  const hoteles = parseHoteles($);

  // ── Precios ────────────────────────────────────────────────────────────────
  const ps = textoPlano.search(/(?:Valor de la excursi[oó]n|COSTO\s+POR\s+PERSONA|PRECIO\s+POR\s+PERSONA)/i);
  const pe = textoPlano.search(/Plaza\s+[Cd]e\s+[Cc]agancha/i);
  const precioBlock = ps !== -1
    ? textoPlano.slice(ps, pe !== -1 ? pe : undefined)
    : textoPlano;

  // Obtener también el HTML del bloque de precios (para promoTexto más fiel si hace falta)
  const precios = parsePrecioBlock(precioBlock, '');

  // ── Salidas ────────────────────────────────────────────────────────────────
  const salidas = [];

  // Fuente 1: <div class="descr">Salida DD Mes YYYY - Hora HH:MM</div>
  $('div.descr').each((_, el) => {
    const txt = clean($(el).text());
    if (/^Salida\s+\d{1,2}/i.test(txt)) {
      const val = txt.replace(/^Salida\s+/i, '').trim();
      if (val.length > 3 && !salidas.some(s => s.toLowerCase() === val.toLowerCase())) {
        salidas.push(val);
      }
    }
  });

  // Fuente 2: "Salidas?: TEXTO" en texto plano
  const salidaTagM = textoPlano.match(/Salidas?:\s*([^\n]+)/i);
  if (salidaTagM) {
    const val = clean(salidaTagM[1]).replace(/\*+/g, '').trim();
    if (val.length > 3 && !salidas.some(s => s.toLowerCase() === val.toLowerCase())) {
      salidas.push(val);
    }
  }

  // Fuente 3: "Salida DD de MES..." en texto plano
  // Normalizar para evitar duplicados con variantes como "PROGRAMADA SABADO 16 de Mayo..."
  // vs "16 Mayo 2026 - Hora 17:30" (misma salida, distinto texto)
  function normalizeSalida(s) {
    return s.toUpperCase()
      .replace(/PROGRAMADA\s*/g, '')
      .replace(/HORA\s+DE\s+SALIDA:\s*/g, '')
      .replace(/[-\u2013]\s*HORA\s+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  const SALIDA_RX = /\*{0,3}\s*Salida\s+([^\n*]{5,80}(?:hs|Hs|HRS)?)/gi;
  let sm;
  while ((sm = SALIDA_RX.exec(textoPlano)) !== null) {
    const val = clean(sm[1]).replace(/\*+/g, '').trim();
    if (val.length < 4) continue;
    const normVal = normalizeSalida(val);
    if (salidas.some(s => normalizeSalida(s) === normVal)) continue;
    // Evitar líneas que sean solo "DD Mes YYYY - Hora HH:MM" (ya en div.descr)
    if (/^\d{1,2}\s+\w+\s+\d{4}\s*[-\u2013]\s*hora/i.test(val)) continue;
    salidas.push(val);
  }

  // ── Notas ──────────────────────────────────────────────────────────────────
  const FOOTER_EXCL = /Plaza\s+Ca[gz]ancha|www\.rutatur|Pocitos|Montevideo\s*[\d,]/i;
  const notas = [];

  // Butaca y Menor desde precios → notas
  if (precios._butacaNota) {
    notas.push(precios._butacaNota.replace(/\*+/g, '').trim());
    delete precios._butacaNota;
  }
  if (precios._menorNota) {
    notas.push(precios._menorNota.replace(/\*+/g, '').trim());
    delete precios._menorNota;
  }

  for (const line of lineas) {
    if (
      /menor|asiento|butaca|contado|importante|políticas|cancelación|free|invitado/i.test(line) &&
      line.length > 15 && line.length < 300 &&
      !FOOTER_EXCL.test(line) &&
      // Excluir líneas de bloque de precios
      !/BASE\s+(?:DOBLE|TRIPLE|CUADRUPLE)/i.test(line) &&
      // Excluir encabezado del bloque PROMO (ya va en promoTexto)
      !/^PROMO\s+VALIDO/i.test(line) &&
      // Excluir líneas "Valor por persona en..."
      !/^Valor\s+por\s+persona/i.test(line)
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
    titulo      : tituloRaw,
    subtitulo   : durStr,
    duracion    : durStr,
    destino     : titulo,
    destinoSlug,
    pais        : PAIS_MAP[destinoSlug]  || 'Otros',
    emoji       : EMOJI_MAP[destinoSlug] || '📍',
    imagen,
    highlights  : highlightsFinal,
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
  console.log('🚌 Scraper Rutatur v2.3 – BestWay Viajes\n');

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
        ? `U$S ${p.doble}${p.promo ? ` / promo U$S ${p.promo}` : p.promoDoble ? ` / promo U$S ${p.promoDoble}` : ''}`
        : '—';
      console.log(
        `   ✅ ${prog.itinerario.length} días | ` +
        `${prog.hoteles[0]?.nombre?.substring(0, 35) || '—'} | ` +
        `${precioLabel}${p.singleLabel ? ` | ${p.singleLabel}` : ''}`
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
