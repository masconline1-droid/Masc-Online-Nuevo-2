// Edge Function: redactar-ia
//
// Proxy seguro entre el frontend de MASC Digital y la API de Gemini.
// La clave de Gemini vive SOLO en los secretos de este proyecto de Supabase
// (variable de entorno GEMINI_API_KEY) y nunca llega al navegador del usuario.
//
// Requiere sesión válida de Supabase (verify_jwt = true al desplegar), así
// que solo los usuarios logueados en la app pueden consumir cuota de Gemini.
//
// Contrato:
//   POST { campo: "conflicto" | "antecedentes" | "propuesta", contexto: {...} }
//   -> { texto, campo, modelo, generadoIA: true }

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
// Configurable por si cambia el modelo disponible para tu cuenta/clave.
// Comprueba en aistudio.google.com qué modelos tienes habilitados.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CAMPOS_VALIDOS: Record<string, { titulo: string; instrucciones: string }> = {
  conflicto: {
    titulo: 'Descripción del conflicto',
    instrucciones:
      'Redacta un único párrafo que describa de forma clara y jurídicamente precisa el objeto del conflicto entre el solicitante y el requerido, listo para encabezar un burofax/buromail extrajudicial. Debe poder coincidir sustancialmente con el futuro "petitum" de una demanda civil. No inventes hechos, fechas ni cantidades que no se hayan proporcionado.',
  },
  antecedentes: {
    titulo: 'Antecedentes',
    instrucciones:
      'Redacta los antecedentes de hecho relevantes para este expediente, en párrafos breves y en orden cronológico si es posible, basándote únicamente en los datos proporcionados. No inventes fechas, cantidades ni hechos no mencionados; si falta un dato concreto, redacta de forma genérica evitando afirmaciones no confirmadas.',
  },
  propuesta: {
    titulo: 'Propuesta de resolución',
    instrucciones:
      'Redacta una propuesta de resolución extrajudicial concreta y razonable para este conflicto, en tono conciliador pero firme, coherente con los antecedentes y la descripción del conflicto proporcionados.',
  },
};

function limitar(texto: unknown, maxLen = 800): string {
  if (typeof texto !== 'string') return '';
  return texto.slice(0, maxLen);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método no permitido.' }, 405);
  }

  if (!GEMINI_API_KEY) {
    return jsonResponse(
      { error: 'Falta configurar el secreto GEMINI_API_KEY en este proyecto de Supabase (Edge Functions → Secrets).' },
      500
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'JSON inválido en el cuerpo de la petición.' }, 400);
  }

  const campo = body?.campo;
  const config = CAMPOS_VALIDOS[campo];
  if (!config) {
    return jsonResponse(
      { error: 'Campo no soportado. Usa uno de: ' + Object.keys(CAMPOS_VALIDOS).join(', ') },
      400
    );
  }

  const contexto = body?.contexto || {};
  const datosFormateados = [
    contexto.tipo ? `Tipo de expediente: ${limitar(contexto.tipo, 80)}` : null,
    contexto.asunto ? `Asunto: ${limitar(contexto.asunto, 200)}` : null,
    contexto.solicitante ? `Solicitante (a quien representa el despacho): ${limitar(contexto.solicitante, 200)}` : null,
    contexto.requerido ? `Requerido (destinatario de la notificación): ${limitar(contexto.requerido, 200)}` : null,
    contexto.descripcionActual ? `Descripción del conflicto ya redactada: ${limitar(contexto.descripcionActual, 800)}` : null,
    contexto.antecedentesActual ? `Antecedentes ya redactados: ${limitar(contexto.antecedentesActual, 800)}` : null,
    contexto.propuestaActual ? `Propuesta ya redactada: ${limitar(contexto.propuestaActual, 800)}` : null,
    contexto.notas ? `Notas adicionales del letrado: ${limitar(contexto.notas, 500)}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `Eres un asistente de redacción para un despacho de abogados español especializado en Medios Adecuados de Solución de Controversias (MASC): mediación, arbitraje y conciliación extrajudicial.

Vas a redactar EXCLUSIVAMENTE el bloque "${config.titulo}" de un burofax/buromail extrajudicial, a partir de estos datos:
${datosFormateados || '(sin datos adicionales proporcionados)'}

Instrucciones específicas: ${config.instrucciones}

Reglas estrictas:
- Responde SOLO con el texto del párrafo o párrafos solicitados, sin título, sin encabezado, sin comillas, sin explicaciones tuyas.
- Español jurídico pero claro y directo.
- No inventes fechas, cantidades, direcciones ni hechos que no se hayan dado.
- No incluyas firma ni fórmulas de despedida.`;

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const mensaje = data?.error?.message || 'Error al llamar a la API de Gemini.';
      return jsonResponse({ error: mensaje }, geminiRes.status);
    }

    const texto = (data?.candidates?.[0]?.content?.parts || [])
      .map((p: any) => p.text || '')
      .join('')
      .trim();

    if (!texto) {
      return jsonResponse(
        { error: 'Gemini no ha devuelto texto. Puede que el contenido haya sido bloqueado por los filtros de seguridad.' },
        502
      );
    }

    return jsonResponse({
      texto,
      campo,
      modelo: GEMINI_MODEL,
      generadoIA: true,
    });
  } catch (err) {
    return jsonResponse({ error: 'Error inesperado al contactar con Gemini: ' + (err as Error).message }, 500);
  }
});
