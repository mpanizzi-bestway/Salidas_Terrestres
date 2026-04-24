/**
 * scraper.js — BestWay Viajes
 * Scrapea todos los programas de Sendas Turismo y genera programas-sendas.json
 * Ejecutar: node scraper.js
 * También llamado por GitHub Actions semanalmente.
 */

const axios  = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const BASE = 'https://www.sendasturismo.com/as';

// ─── Mapa de destinos con sus URLs de índice ───────────────────────────────
// Cada entrada tiene: país, emoji, slug interno, URL en Sendas
const DESTINATION_INDEXES = [
  // BRASIL
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Florianópolis',     slug: 'florianopolis', url: `${BASE}/index.php/brasil/floripa1` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Gramado y Canela',   slug: 'gramado',       url: `${BASE}/index.php/brasil/gramado` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Ferrugem',           slug: 'ferrugem',      url: `${BASE}/index.php/brasil/ferrugem` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Camboriú',           slug: 'camboriu',      url: `${BASE}/index.php/brasil/camboriu` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Bombinhas',          slug: 'bombinhas',     url: `${BASE}/index.php/brasil/bombinhas` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Capão da Canoa',     slug: 'capao',         url: `${BASE}/index.php/brasil/capao-da-canoa` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Torres',             slug: 'torres',        url: `${BASE}/index.php/brasil/torres` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Laguna',             slug: 'laguna',        url: `${BASE}/index.php/brasil/laguna` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Praia da Rosa',      slug: 'praiarosa',     url: `${BASE}/index.php/brasil/praia-da-rosa` },
  { pais: 'Brasil',    emoji: '🇧🇷', destino: 'Blumenau',           slug: 'blumenau',      url: `${BASE}/index.php/brasil/blumenau` },
  // ARGENTINA
  { pais: 'Argentina', emoji: '🇦🇷', destino: 'Buenos Aires',       slug: 'buenosaires',   url: `${BASE}/index.php/argentina` },
  { pais: 'Argentina', emoji: '🇦🇷', destino: 'Mendoza',            slug: 'mendoza',       url: `${BASE}/index.php/argentina` },
  { pais: 'Argentina', emoji: '🇦🇷', destino: 'Norte Argentino',    slug: 'norte',         url: `${BASE}/index.php/argentina` },
  { pais: 'Argentina', emoji: '🇦🇷', destino: 'Carlos Paz',         slug: 'carlospaz',     url: `${BASE}/index.php/argentina` },
  { pais: 'Argentina', emoji: '🇦🇷', destino: 'Bariloche',          slug: 'bariloche',     url: `${BASE}/index.php/argentina` },
  // CATARATAS
  { pais: 'Cataratas', emoji: '💧', destino: 'Cataratas del Iguazú', slug: 'cataratas',    url: `${BASE}/index.php/cataratas` },
  // CHILE
  { pais: 'Chile',     emoji: '🇨🇱', destino: 'Chile',              slug: 'chile',         url: `${BASE}/index.php/chile` },
  { pais: 'Chile',     emoji: '🇨🇱', destino: 'Mendoza y Santiago', slug: 'mendozasantiago', url: `${BASE}/index.php/mendoza-y-santiago` },
];

// Keywords de destino para asignar correctamente desde listados de Argentina (índice mixto)
const DEST_KEYWORDS = {
  'buenosaires': ['buenos aires','temaiken','mundo marino','parque de la costa'],
  'mendoza':     ['mendoza'],
  'norte':       ['norte argentino','jujuy','salta','tucuman','tafi'],
  'carlospaz':   ['carlos paz','cordoba','sierras'],
  'bariloche':   ['bariloche','patagonia'],
  'cataratas':   ['cataratas','iguazu','iguazú'],
  'chile':       ['chile','santiago','valparaiso'],
  'mendozasantiago': ['mendoza y santiago'],
};

// Icono por destino
const DEST_EMOJI = {
  'florianopolis': '🏖️', 'gramado': '🌲', 'ferrugem': '🌊', 'camboriu': '🎡',
  'bombinhas': '🐚', 'capao': '🏄', 'torres': '⛵', 'laguna': '🦀',
  'praiarosa': '🌹', 'blumenau': '🌸',
  'buenosaires': '🏙️', 'mendoza': '🍷', 'norte': '🏔️', 'carlospaz': '⛰️', 'bariloche': '🏔️',
  'cataratas': '🌊', 'chile': '🇨🇱', 'mendozasantiago': '🏔️',
};

// Foto de búsqueda por destino (para Unsplash/Pexels en el frontend)
const DEST_PHOTO_QUERY = {
  'florianopolis': 'Florianopolis beach Brazil', 'gramado': 'Gramado Rio Grande do Sul',
  'ferrugem': 'Praia da Ferrugem Santa Catarina', 'camboriu': 'Balneario Camboriu beach',
  'bombinhas': 'Bombinhas Santa Catarina beach', 'capao': 'Capao da Canoa beach',
  'torres': 'Torres praia Rio Grande do Sul', 'laguna': 'Laguna Santa Catarina',
  'praiarosa': 'Praia do Rosa Santa Catarina', 'blumenau': 'Blumenau cidade Alemã',
  'buenosaires': 'Buenos Aires city Argentina', 'mendoza': 'Mendoza viñedos Argentina',
  'norte': 'Jujuy quebrada Humahuaca Argentina', 'carlospaz': 'Carlos Paz Cordoba Argentina',
  'bariloche': 'Bariloche Patagonia Argentina', 'cataratas': 'Cataratas Iguazu waterfall',
  'chile': 'Santiago Chile city', 'mendozasantiago': 'Mendoza Santiago Andes',
};

// ─── Pausa para no sobrecargar el servidor ─────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// User-Agent pool para rotar
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
let uaIndex = 0;

// ─── Fetch con reintentos ───────────────────────────────────────────────────
async function fetchHTML(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const ua = UA_POOL[uaIndex++ % UA_POOL.length];
      const res = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-UY,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://www.google.com/',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
        maxRedirects: 5,
      });
      return res.data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

// ─── Extraer links de programas de una página de índice ────────────────────
async function getLinksFromIndex(indexUrl, destSlug) {
  const html = await fetchHTML(indexUrl);
  const $    = cheerio.load(html);
  const links = [];
  const seen  = new Set();

  // Joomla article links: contienen el ID numérico en la URL
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    // Filtrar: solo artículos del sitio de Sendas con ID numérico
    if (
      href.includes('sendasturismo.com') &&
      /\/\d{3,4}-/.test(href) &&
      !href.includes('print=') &&
      !href.includes('mailto') &&
      text.length > 5 &&
      !seen.has(href)
    ) {
      seen.add(href);
      links.push({ href, text });
    }
  });

  return links;
}

// ─── Parsear un programa individual ────────────────────────────────────────
// Estructura real del HTML de Sendas Turismo:
//
//   **SALIDAS: SABADOS DEL 11 DE JULIO AL 21 DE NOVIEMBRE...**   ← <p><strong>
//   ***Incluye:***                                                ← <p><strong><em>
//   -      *Bus semi cama*                                        ← <p> con guión
//   -      *Guía acompañante...*
//   ...
//   -      *Seguro de Asistencia médica de Universal Assistance*  ← ÚLTIMO ITEM
//   **Día 01 Uruguay**- Salida en bus...                          ← inicio itinerario
//
function parseProgram(html, sourceUrl, destInfo) {
  const $ = cheerio.load(html);

  // El artículo real está en div.item-page (Joomla)
  const articleEl = $('div.item-page');
  const rawText   = articleEl.text();

  // ── TÍTULO ────────────────────────────────────────────────────────────────
  // Joomla pone el título en el primer <h2> dentro de item-page
  const titleRaw = articleEl.find('h2').first().text().trim()
    || $('title').text().replace(/sendas turismo.*/i,'').replace(/[|-].*/,'').trim();
  const title = titleRaw.replace(/\s+/g,' ').toUpperCase().substring(0,80);

  // ── DÍAS / NOCHES ─────────────────────────────────────────────────────────
  const diasM   = rawText.match(/(\d+)\s*d[ií]as?/i);
  const nochesM = rawText.match(/(\d+)\s*noches?/i);
  const dias   = diasM   ? diasM[1]   : null;
  const noches = nochesM ? nochesM[1] : null;

  // ── SALIDAS ───────────────────────────────────────────────────────────────
  // Formato real: **SALIDAS: SABADOS DEL 11 DE JULIO AL 21 DE NOVIEMBRE...**
  // Puede venir en párrafos <p><strong> o como texto plano
  let salidas = null;
  articleEl.find('p, strong').each((_, el) => {
    const t = $(el).text().trim();
    // Buscar la línea que empieza con "SALIDAS:"
    const m = t.match(/^salidas?:\s*(.+)/i);
    if (m && !salidas) {
      salidas = m[1].replace(/\*/g,'').trim();
      // Truncar en el primer punto o paréntesis largo
      salidas = salidas.split(/\n/)[0].trim().substring(0, 120);
    }
  });
  // Fallback en texto plano
  if (!salidas) {
    const m = rawText.match(/salidas?:\s*([^\n]{5,120})/i);
    if (m) salidas = m[1].replace(/\*/g,'').trim();
  }

  // ── INCLUYE ───────────────────────────────────────────────────────────────
  // Empieza después de "Incluye:" y termina antes de "**Día 01" o tabla de precios.
  // Los items son párrafos que empiezan con "-" (guión + espacios).
  // El último ítem siempre contiene "Universal Assistance" o "Seguro".
  const incluye = [];

  // Obtenemos el texto del artículo línea a línea
  const lines = rawText.split('\n');
  let capturingIncluye = false;
  const STOP_INCLUYE = /^d[ií]a\s+0?1\b/i;       // "Día 01 ..."
  const MARKER_INCLUYE = /incluye\s*:?\s*$/i;      // línea que termina en "Incluye:"
  const ITEM_INCLUYE   = /^[\s\-–•]+(.+)$/;        // - texto / – texto / • texto

  for (const line of lines) {
    const l = line.trim().replace(/\*/g,'').replace(/\s+/g,' ');
    if (!l) continue;

    // Detectar inicio de sección incluye
    if (MARKER_INCLUYE.test(l)) {
      capturingIncluye = true;
      continue;
    }

    if (capturingIncluye) {
      // Parar si llegamos al itinerario
      if (STOP_INCLUYE.test(l)) break;
      // Parar si llegamos a la tabla (HOTEL SGL DBL...)
      if (/\bhotel\b.*\bsgl\b/i.test(l)) break;

      const m = ITEM_INCLUYE.exec(l);
      if (m) {
        const item = m[1].trim();
        if (item.length > 3 && item.length < 250) {
          incluye.push(item);
          // El último ítem siempre es el seguro — después no hay más incluye
          if (/universal assistance|seguro.*asistencia/i.test(item)) {
            break;
          }
        }
      } else if (l.length > 3 && l.length < 250 && !/^[A-ZÁÉÍÓÚÜ\s]{10,}$/.test(l)) {
        // Texto que no es guión pero sigue siendo parte del incluye (ej: continuación)
        // Solo si no es un titular en mayúsculas
      }
    }
  }

  // ── ITINERARIO ────────────────────────────────────────────────────────────
  // Formato real: **Día 01 Uruguay**- Salida en bus...
  //               **Día 02 Florianópolis**- Llegada...
  //               **Día 03 al día 06 Florianópolis.**
  //               **Tour a Camboriú con Cristo Luz:** texto...
  //               **Día 07 Florianópolis**- Desayuno...
  const itinerario = [];

  // Extraemos bloques de texto entre <p><strong> que contengan "Día NN"
  // Trabajamos sobre el HTML para tener mejor control
  const bodyHtml = articleEl.html() || '';

  // Regex sobre el texto completo: captura "Día NN [lugar]" + descripción
  // hasta el siguiente "Día NN" o fin del contenido
  const DIA_RX = /\bD[ií]a\s+(\d{2}(?:\s+al\s+(?:d[ií]a\s+)?\d{2})?)\s+([^*\n\-]{2,50?}?)\*{0,2}[\-\.\:]\s*([\s\S]*?)(?=\bD[ií]a\s+\d{2}\b|(?:\|\s*\*{0,2}HOTEL)|$)/gi;

  let dm;
  while ((dm = DIA_RX.exec(rawText)) !== null) {
    const diaNum  = dm[1].trim();
    const lugar   = dm[2].trim().replace(/[\*\.\-\:]+$/,'').trim();
    let   detalle = dm[3].trim().replace(/\s+/g,' ');

    // Limpiar "Tour a X:" que vienen dentro del bloque multi-día
    detalle = detalle
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')    // quitar asteriscos negrita/itálica
      .replace(/\s+/g,' ')
      .substring(0, 700);

    if (lugar.length > 1 && detalle.length > 5) {
      itinerario.push({
        dia:    `DÍA ${diaNum.toUpperCase()}`,
        lugar:  lugar.substring(0,60),
        detalle,
        first:  itinerario.length === 0,
        last:   false,
      });
    }
  }
  if (itinerario.length > 0) itinerario[itinerario.length-1].last = true;

  // ── TABLA DE PRECIOS ──────────────────────────────────────────────────────
  const hoteles = [];
  articleEl.find('table').each((_, tbl) => {
    const rows = $(tbl).find('tr');
    if (rows.length < 2) return;
    const headerText = $(rows[0]).text().toLowerCase();
    if (!headerText.includes('hotel') && !headerText.includes('sgl')) return;

    rows.each((ri, row) => {
      if (ri === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const nombre = $(cells[0]).text().trim().replace(/\s+/g,' ');
      if (!nombre || /^hotel$/i.test(nombre)) return;

      const parseVal = v => {
        const n = parseInt((v||'').replace(/[^\d]/g,''));
        return isNaN(n) || n === 0 ? null : n;
      };

      // Columna 1 = PLAYA (texto), columnas 2-6 = precios
      const playa = $(cells[1]).text().trim() || '—';
      hoteles.push({
        nombre,
        playa,
        sgl: parseVal($(cells[2]).text()),
        dbl: parseVal($(cells[3]).text()),
        tpl: parseVal($(cells[4]).text()),
        cpl: parseVal($(cells[5]).text()),
        qpl: parseVal($(cells[6]).text()),
        cat: $(cells[0]).find('a').attr('href') || '',
      });
    });
  });

  // ── NOTAS DE PRECIOS ──────────────────────────────────────────────────────
  // Están como párrafos <p><strong> después de la tabla
  const notas = [];
  const notaRx = /(menores[^.:\n]{0,60}|solo bus[^.:\n]{0,60}|no incluye[^.:\n]{0,60})/gi;
  let nm;
  while ((nm = notaRx.exec(rawText)) !== null) {
    const fullLine = rawText.substring(nm.index, nm.index + 200).split('\n')[0].replace(/\*/g,'').trim();
    if (fullLine.length > 10) notas.push({ titulo: 'Nota', texto: fullLine });
  }

  // ── ID / SLUG ─────────────────────────────────────────────────────────────
  const idMatch  = sourceUrl.match(/\/(\d{3,4})-/);
  const joomlaId = idMatch ? idMatch[1] : null;
  const slug     = joomlaId ? `${destInfo.slug}-${joomlaId}` : `${destInfo.slug}-${Date.now()}`;

  return {
    id:          slug,
    joomlaId,
    sourceUrl,
    titulo:      title,
    subtitulo:   buildSubtitulo(dias, noches, destInfo.destino),
    duracion:    dias ? `${dias} DÍAS${noches ? ` — ${noches} NOCHES` : ''}` : 'Consultar',
    destino:     destInfo.destino,
    destinoSlug: destInfo.slug,
    pais:        destInfo.pais,
    emoji:       destInfo.emoji,
    photoQuery:  DEST_PHOTO_QUERY[destInfo.slug] || destInfo.destino,
    fechas:      buildFechas(salidas, null),
    descripcion: buildDescripcion(destInfo.slug, destInfo.destino),
    highlights:  buildHighlights(destInfo.slug, itinerario),
    incluye:     incluye.length > 0 ? incluye : ['Consultar programa completo en agencia'],
    itinerario,
    hoteles,
    notas_precios: notas.length > 0 ? notas : [
      { titulo: 'Precios', texto: 'Consultar tarifas vigentes al momento de la reserva.' }
    ],
    updatedAt: new Date().toISOString(),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function normalizeTitle(t) {
  return t.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')
          .replace(/^\d+\s*-?\s*/,'')
          .toUpperCase().substring(0, 80);
}

function buildSubtitulo(dias, noches, destino) {
  const d = dias   ? `${dias} DÍAS` : '';
  const n = noches ? `${noches} NOCHES` : '';
  const dn = [d, n].filter(Boolean).join(' / ');
  return dn ? `${dn} · ${destino.toUpperCase()}` : destino.toUpperCase();
}

function buildFechas(salidas, temporada) {
  const result = [];
  if (temporada) result.push({ label: 'Temporada', value: temporada, gold: false });
  if (salidas)   result.push({ label: 'Salidas',   value: salidas.substring(0,60), gold: true });
  if (result.length === 0) result.push({ label: 'Salidas', value: 'Consultar disponibilidad', gold: true });
  result.push({ label: 'Operador', value: 'Sendas Turismo', gold: false });
  return result;
}

function buildDescripcion(slug, destino) {
  const desc = {
    florianopolis: 'Canasvieiras, en Florianópolis, combina el encanto de las playas brasileñas con aguas cálidas y tranquilas, perfectas para disfrutar todo el día. Con su ambiente alegre, su costa sin sargazo y su mezcla de naturaleza y ritmo local, es el destino ideal para vivir el verdadero verano en Brasil.',
    gramado:       'Gramado y Canela son dos joyas del sur de Brasil que combinan arquitectura alemana, gastronomía de primer nivel y paisajes de montaña únicos. Una experiencia completamente diferente al Brasil típico, llena de historia, chocolate artesanal y naturaleza exuberante.',
    ferrugem:      'Praia da Ferrugem es una de las playas más salvajes y auténticas de Santa Catarina. Rodeada de mata atlántica, con olas ideales para el surf y una atmósfera bohemia que la distingue de los destinos masificados del litoral brasileño.',
    camboriu:      'Balneário Camboriú es la ciudad más visitada de Santa Catarina, con su famosa rambla, teleférico, playas urbanas y la proximidad a Beto Carrero World, el mayor parque de atracciones de Sudamérica.',
    bombinhas:     'Bombinhas es un paraíso de aguas cristalinas en Santa Catarina, con más de 30 playas de arena blanca y una reserva marina que la convierte en uno de los destinos de buceo más importantes de Brasil.',
    capao:         'Capão da Canoa es una clásica estación balnearia del litoral gaúcho, con playas amplias, aguas tranquilas y una infraestructura turística consolidada que la hace ideal para familias.',
    torres:        'Torres es conocida por sus imponentes rocas basálticas que emergen del mar, sus playas de aguas frescas y su faro histórico. Un destino con carácter propio en el litoral de Rio Grande do Sul.',
    laguna:        'Laguna es una ciudad histórica de Santa Catarina, con un centro colonial preservado y famosa por la convivencia entre pescadores y delfines que nadan hacia la orilla para ayudar en la pesca artesanal.',
    praiarosa:     'Praia do Rosa es un refugio de lujo discreto entre dunas y mata atlántica, con ballenas francas que visitan la bahía entre junio y noviembre, y una escena gastronómica de primer nivel.',
    blumenau:      'Blumenau es la capital cultural alemana de Brasil. Su arquitectura enxaimel, la Oktoberfest más grande fuera de Alemania, la producción de cervezas artesanales y el chocolate la hacen única en Sudamérica.',
    buenosaires:   'Buenos Aires combina la pasión del tango con una escena cultural sin igual en América Latina. Parques temáticos, gastronomía porteña, teatros y la calidez del pueblo bonaerense hacen de este destino una experiencia completa.',
    mendoza:       'Mendoza es la capital del vino argentino, al pie de los Andes. Sus bodegas, el Aconcagua, las termas de Cacheuta y sus paisajes de viñedos en otoño la convierten en un destino para todos los sentidos.',
    norte:         'El Norte Argentino despliega los colores mágicos de la Quebrada de Humahuaca, las Salinas Grandes, los cerros de siete colores y los viñedos de altura. Una región de culturas milenarias y naturaleza imponente.',
    carlospaz:     'Carlos Paz y las Sierras de Córdoba ofrecen un destino familiar por excelencia: teatro, dique, teleférico y la naturaleza serrana a pocos pasos. Perfecto para vacaciones de invierno con toda la familia.',
    bariloche:     'Bariloche es la joya de la Patagonia argentina. En invierno, el Cerro Catedral y sus pistas de ski la convierten en la capital andina del sur. En cualquier época, los Lagos, los bosques y el chocolate artesanal son imperdibles.',
    cataratas:     'Las Cataratas del Iguazú son una de las Siete Maravillas Naturales del Mundo. El estruendo del agua, la niebla permanente y la selva que las rodea generan una experiencia que no se olvida jamás.',
    chile:         'Chile ofrece una diversidad geográfica incomparable: desierto en el norte, lagos y volcanes en el sur, y Santiago como capital cosmopolita. Un destino que combina modernidad, historia y naturaleza salvaje.',
    mendozasantiago: 'La ruta Mendoza–Santiago cruza la cordillera de los Andes por el paso Cristo Redentor, combinando lo mejor de la Argentina vitivinícola con la modernidad de la capital chilena y sus alrededores.',
  };
  return desc[slug] || `${destino} es un destino imperdible que ofrece experiencias únicas para quienes viajan desde Uruguay con Sendas Turismo.`;
}

function buildHighlights(slug, itinerario) {
  const defaults = {
    florianopolis: ['🏖️ Playas cristalinas','⛵ Paseo en Scuna','🎢 Beto Carrero World','✝️ Cristo Luz','🐬 Golfinhos','🌊 Laguna Concepción'],
    gramado:       ['🌲 Parques naturales','🍫 Chocolate artesanal','⛪ Arquitectura europea','🎭 Gramado','🌊 Cascatas','🚂 Maria Fumaça'],
    ferrugem:      ['🌊 Playa salvaje','🏄 Surf','🌿 Mata atlántica','🦋 Naturaleza','🐠 Vida marina','☀️ Atardeceres'],
    camboriu:      ['🏖️ Rambla','🚡 Teleférico','🎢 Beto Carrero','🌅 Puesta de sol','🛍️ Shopping','🏊 Playas urbanas'],
    bombinhas:     ['🐠 Buceo','🏖️ 30 playas','🌊 Aguas cristalinas','🐬 Reserva marina','🌿 Naturaleza','⛵ Paseos náuticos'],
    buenosaires:   ['🎭 Tango','🍖 Asado','⛵ Tigre Delta','🎠 Temaiken','🌊 Mundo Marino','🎡 Parque de la Costa'],
    mendoza:       ['🍷 Vinos premium','🏔️ Aconcagua','♨️ Termas Cacheuta','🌅 Cordillera','🍇 Vendimia','🚵 Aventura'],
    norte:         ['🌈 Cerros de colores','🏔️ Quebrada Humahuaca','🧂 Salinas Grandes','🌵 Puna','🎨 Arte rupestre','🦙 Llamas'],
    carlospaz:     ['⛰️ Sierras','🎠 Teleférico','🎭 Teatro','💧 Dique San Roque','🌲 Naturaleza','👨‍👩‍👧 Familias'],
    bariloche:     ['⛷️ Ski','🍫 Chocolate','🏔️ Cerro Catedral','🦆 Lagos patagónicos','🌲 Bosques','🚡 Teleférico'],
    cataratas:     ['🌊 Cataratas Iguazú','🛥️ Bote al pie','🇦🇷 Lado argentino','🇧🇷 Lado brasileño','🦋 Selva','🌈 Arco iris'],
    chile:         ['🏙️ Santiago moderno','⛰️ Andes','🍷 Vinos','🎨 Valparaíso','🏖️ Costa','🌿 Naturaleza'],
    mendozasantiago: ['🍷 Bodegas','🏔️ Cristo Redentor','🌆 Santiago','🛣️ Ruta andina','⛷️ Portillo','🍇 Viñedos'],
  };
  if (defaults[slug]) return defaults[slug];
  // Generar desde itinerario si hay
  return itinerario.slice(0,3).map(d => `📍 ${d.lugar.substring(0,25)}`);
}

// ─── URLs conocidas como fallback ─────────────────────────────────────────
// Usadas cuando el índice dinámico no devuelve resultados (ej: bloqueo temporal).
// Actualizar si Sendas agrega programas nuevos.
const KNOWN_URLS = [
  // FLORIANÓPOLIS
  { url: `${BASE}/index.php/brasil/floripa1/1413-florianopolis-8-dias-julio-a-noviembre-2`, slug: 'florianopolis' },
  { url: `${BASE}/index.php/brasil/floripa1/1400-florianopolis-8-dias-vacaciones-de-julio`, slug: 'florianopolis' },
  { url: `${BASE}/index.php/brasil/floripa1/1396-florianopolis-8-dias-abril-a-junio`,       slug: 'florianopolis' },
  // GRAMADO
  { url: `${BASE}/index.php/brasil/gramado/1417-gramado-y-canela-7-dias-verano`,                        slug: 'gramado' },
  { url: `${BASE}/index.php/brasil/gramado/1416-canela-en-navidad-o-fin-de-ano-7-dias-21-y-28-de-diciembre`, slug: 'gramado' },
  { url: `${BASE}/index.php/brasil/gramado/1415-gramado-y-canela-natal-luz-7-idas-octubre-a-diciembre`, slug: 'gramado' },
  { url: `${BASE}/index.php/brasil/gramado/1411-gramado-y-canela-7-dias-agosto-a-octubre-4`,            slug: 'gramado' },
  { url: `${BASE}/index.php/brasil/gramado/1400-gramado-y-canela-7-dias-vacaciones-de-julio-3`,         slug: 'gramado' },
  { url: `${BASE}/index.php/brasil/gramado/1396-gramado-y-canela-7-dias-abril-a-junio-3`,               slug: 'gramado' },
  // FERRUGEM, CAMBORIÚ, BOMBINHAS
  { url: `${BASE}/index.php/brasil/ferrugem`, slug: 'ferrugem'  },
  { url: `${BASE}/index.php/brasil/camboriu`, slug: 'camboriu'  },
  { url: `${BASE}/index.php/brasil/bombinhas`,slug: 'bombinhas' },
  // ARGENTINA
  { url: `${BASE}/index.php/argentina/1414-temaiken-buenos-aires-mundo-marino-y-parque-de-la-costa-vacaciones-de-julio-4`, slug: 'buenosaires' },
  { url: `${BASE}/index.php/argentina/1412-mendoza-8-dias-agosto-a-noviembre-3`,              slug: 'mendoza'     },
  { url: `${BASE}/index.php/argentina/1407-mendoza-8-dias-vacaciones-de-julio-4`,             slug: 'mendoza'     },
  { url: `${BASE}/index.php/argentina/1358-mendoza-8-dias-marzo-a-junio-2`,                   slug: 'mendoza'     },
  { url: `${BASE}/index.php/argentina/1406-norte-argentino-10-dias-tjs-27-de-junio-vacaciones-de-julio`, slug: 'norte' },
  { url: `${BASE}/index.php/argentina/1405-norte-argentino-10-dias-tsj-26-de-junio-vacaciones-de-julio`, slug: 'norte' },
  { url: `${BASE}/index.php/argentina/1395-norte-argentino-10-dias-tafi-salta-jujuy-abril-a-junio`,      slug: 'norte' },
  { url: `${BASE}/index.php/argentina/1394-norte-argentino-10-dias-tafi-jujuy-salta-abril-a-junio`,      slug: 'norte' },
  { url: `${BASE}/index.php/argentina/1404-carlos-paz-8-dias-vacaciones-de-julio-5`,          slug: 'carlospaz'   },
  { url: `${BASE}/index.php/argentina/1403-bariloche-9-dias-vacaciones-de-julio-6`,           slug: 'bariloche'   },
  { url: `${BASE}/index.php/argentina/1386-bariloche-9-dias-promocional-16-de-mayo`,          slug: 'bariloche'   },
  // CATARATAS
  { url: `${BASE}/index.php/cataratas/1410-cataratas-7-dias-agosto-a-diciembre-2`,  slug: 'cataratas' },
  { url: `${BASE}/index.php/cataratas/1409-cataratas-7-dias-4-11-y-18-de-julio`,    slug: 'cataratas' },
  { url: `${BASE}/index.php/cataratas/1401-cataratas-7-dias-vacaciones-de-julio-5`, slug: 'cataratas' },
  { url: `${BASE}/index.php/cataratas/1393-cataratas-7-dias-abril-a-junio`,         slug: 'cataratas' },
];

// ─── Función principal ──────────────────────────────────────────────────────
async function scrapeAll() {
  console.log('🚀 Iniciando scraping de Sendas Turismo...\n');
  const result = {
    operador: 'Sendas Turismo',
    updatedAt: new Date().toISOString(),
    programas: [],
  };

  const seenUrls = new Set();

  // ── FASE 1: scraping dinámico de índices ───────────────────────────────
  console.log('─── FASE 1: Scraping dinámico de índices ───\n');
  for (const destInfo of DESTINATION_INDEXES) {
    console.log(`\n📂 ${destInfo.pais} › ${destInfo.destino}`);
    await sleep(1200);

    let links = [];
    try {
      links = await getLinksFromIndex(destInfo.url, destInfo.slug);
      console.log(`   Encontrados ${links.length} links`);
    } catch (e) {
      console.warn(`   ⚠️  Índice no accesible: ${e.message} — se usará fallback`);
    }

    for (const link of links) {
      const url = link.href.startsWith('http') ? link.href : `https://www.sendasturismo.com${link.href}`;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      // Para Argentina/Cataratas (índice mixto), filtrar por keywords
      if (destInfo.pais === 'Argentina' || destInfo.pais === 'Cataratas') {
        const keywords = DEST_KEYWORDS[destInfo.slug] || [];
        const textLower = link.text.toLowerCase();
        if (!keywords.some(kw => textLower.includes(kw))) continue;
      }

      await sleep(900);
      try {
        const html = await fetchHTML(url);
        const prog = parseProgram(html, url, destInfo);
        if (prog.titulo && prog.titulo.length > 3) {
          result.programas.push(prog);
          console.log(`   ✅ ${prog.titulo}`);
        }
      } catch (e) {
        console.warn(`   ❌ Error en ${url}: ${e.message}`);
      }
    }
  }

  // ── FASE 2: fallback con URLs conocidas ────────────────────────────────
  const programasAntes = result.programas.length;
  console.log(`\n─── FASE 2: Fallback URLs conocidas (${KNOWN_URLS.length} URLs) ───\n`);

  for (const { url, slug } of KNOWN_URLS) {
    if (seenUrls.has(url)) {
      console.log(`   ⏭️  Ya scrapeado: ${url.split('/').pop()}`);
      continue;
    }
    seenUrls.add(url);

    // Encontrar destInfo por slug
    const destInfo = DESTINATION_INDEXES.find(d => d.slug === slug);
    if (!destInfo) continue;

    await sleep(900);
    try {
      const html = await fetchHTML(url);
      const prog = parseProgram(html, url, destInfo);
      if (prog.titulo && prog.titulo.length > 3) {
        result.programas.push(prog);
        console.log(`   ✅ [fallback] ${prog.titulo}`);
      }
    } catch (e) {
      console.warn(`   ❌ [fallback] Error en ${url}: ${e.message}`);
    }
  }

  const fallbackNuevos = result.programas.length - programasAntes;
  if (fallbackNuevos > 0) {
    console.log(`\n   📋 Fallback agregó ${fallbackNuevos} programas adicionales`);
  }

  // ── Guardar JSON ──────────────────────────────────────────────────────
  if (result.programas.length === 0) {
    console.error('\n❌ ERROR: No se obtuvo ningún programa. El JSON no se sobreescribirá.');
    console.error('   Verificar conectividad o si Sendas cambió su estructura.');
    process.exit(1);
  }

  const outPath = path.join(__dirname, 'programas-sendas.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ Scraping completado. ${result.programas.length} programas guardados en programas-sendas.json`);
  console.log(`   Dinámico: ${programasAntes} | Fallback: ${fallbackNuevos}`);
}

scrapeAll().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
