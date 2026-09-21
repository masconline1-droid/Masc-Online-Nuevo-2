// Edge Function: enviar-notificacion
//
// Envía por email la notificación de un expediente MASC a los tres
// destinatarios: el despacho/letrado logado (email extraído de su propia
// sesión, no de un campo editable), el solicitante y el requerido.
//
// Sustituye al envío anterior, que se hacía desde el navegador saltándose
// CORS mediante proxies públicos (api.cors.lol, corsproxy.io, thingproxy)
// y guardaba la clave de Resend en localStorage. Ahora la clave vive SOLO
// en los secretos de este proyecto de Supabase (RESEND_API_KEY) y el
// envío se hace servidor a servidor, sin proxies ni exposición de la clave.
//
// Requiere sesión válida de Supabase (verify_jwt = true al desplegar), así
// que solo los usuarios logueados en la app pueden disparar envíos.
//
// Contrato:
//   POST {
//     expId, conflicto,
//     solicitante: { nombre, email },
//     requerido: { nombre, email }
//   }
//   -> { enviados: [email, ...], fallidos: [{ email, rol, motivo }, ...] }

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
// Debe ser un remitente o dominio validado en tu panel de Resend. Si usas
// la cuenta de pruebas de Resend, deja 'onboarding@resend.dev' (sólo
// entrega a la dirección con la que te registraste en Resend).
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'onboarding@resend.dev';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// El runtime de Supabase ya ha verificado la firma del JWT antes de que
// esta función se ejecute (verify_jwt = true al desplegar). Aquí solo
// decodificamos el payload para leer el email de la sesión, evitando así
// que el "destinatario despacho" dependa de un valor que el propio cliente
// podría manipular.
function emailDesdeJWT(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const partes = token.split('.');
  if (partes.length < 2) return null;
  try {
    const payloadB64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
    const payloadJson = atob(payloadB64);
    const payload = JSON.parse(payloadJson);
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

function limitar(texto: unknown, maxLen = 2000): string {
  return typeof texto === 'string' ? texto.slice(0, maxLen) : '';
}

function esEmailValido(email: unknown): email is string {
  return (
    typeof email === 'string' &&
    /\S+@\S+\.\S+/.test(email) &&
    !email.toLowerCase().includes('ejemplo') &&
    !email.toLowerCase().includes('correo.com')
  );
}

function escapeHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function plantillaEmail(d: {
  expId: string; conflicto: string;
  solNombre: string; solEmail: string;
  reqNombre: string; reqEmail: string;
  despachoEmail: string;
}): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 20px;">
        <h2 style="color: #0f172a; margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em;">MASC Digital</h2>
        <p style="color: #64748b; font-size: 13px; margin: 4px 0 0 0;">Notificación formal de mediación extrajudicial</p>
      </div>

      <p style="font-size: 14px; color: #334155; line-height: 1.6;">Estimadas partes,</p>
      <p style="font-size: 14px; color: #334155; line-height: 1.6;">Les notificamos el inicio formal de un expediente y reclamación en el marco de la mediación MASC (Medios Alternativos de Resolución de Conflictos) según la legislación vigente.</p>

      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin: 20px 0;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">Datos del Expediente</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 4px 0; color: #64748b; width: 120px;"><strong>Referencia:</strong></td>
            <td style="padding: 4px 0; color: #0f172a;"><strong>${escapeHtml(d.expId)}</strong></td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #64748b;"><strong>Solicitante:</strong></td>
            <td style="padding: 4px 0; color: #0f172a;">${escapeHtml(d.solNombre)} (${escapeHtml(d.solEmail)})</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #64748b;"><strong>Requerido:</strong></td>
            <td style="padding: 4px 0; color: #0f172a;">${escapeHtml(d.reqNombre)} (${escapeHtml(d.reqEmail)})</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #64748b;"><strong>Despacho:</strong></td>
            <td style="padding: 4px 0; color: #0f172a;">${escapeHtml(d.despachoEmail)}</td>
          </tr>
        </table>

        <h4 style="margin: 14px 0 6px 0; font-size: 13px; color: #0f172a;">Descripción de la reclamación:</h4>
        <p style="margin: 0; font-size: 12.5px; color: #475569; line-height: 1.5; background: #ffffff; border-left: 3px solid #2563eb; padding: 8px 12px; border-radius: 4px;">${escapeHtml(d.conflicto)}</p>
      </div>

      <p style="font-size: 13.5px; color: #334155; line-height: 1.6;">El expediente y documento vinculante correspondientes han sido certificados con valor probatorio. Pueden responder a esta notificación contactando directamente con el despacho de abogados en ${escapeHtml(d.despachoEmail)}.</p>

      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">Remitido digitalmente a través de MASC Digital. Copia de registro en base de datos.</p>
    </div>
  `;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método no permitido.' }, 405);
  }

  if (!RESEND_API_KEY) {
    return jsonResponse(
      { error: 'Falta configurar el secreto RESEND_API_KEY en este proyecto de Supabase (Edge Functions → Secrets).' },
      500
    );
  }

  const despachoEmail = emailDesdeJWT(req.headers.get('Authorization'));
  if (!despachoEmail) {
    return jsonResponse({ error: 'No se ha podido determinar el email del usuario logado a partir de la sesión.' }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'JSON inválido en el cuerpo de la petición.' }, 400);
  }

  const expId = limitar(body?.expId, 60) || '(sin referencia)';
  const conflicto = limitar(body?.conflicto, 2000);
  const solicitante = body?.solicitante || {};
  const requerido = body?.requerido || {};
  const solNombre = limitar(solicitante.nombre, 200);
  const solEmail = limitar(solicitante.email, 200);
  const reqNombre = limitar(requerido.nombre, 200);
  const reqEmail = limitar(requerido.email, 200);

  const html = plantillaEmail({ expId, conflicto, solNombre, solEmail, reqNombre, reqEmail, despachoEmail });

  const destinatarios: { email: string; rol: string }[] = [
    { email: despachoEmail, rol: 'Despacho' },
    { email: solEmail, rol: 'Solicitante' },
    { email: reqEmail, rol: 'Requerido' },
  ];

  const enviados: string[] = [];
  const fallidos: { email: string; rol: string; motivo: string }[] = [];

  for (const dest of destinatarios) {
    if (!esEmailValido(dest.email)) {
      // El email del despacho (viene de la sesión real) casi nunca caerá
      // aquí; esto filtra sobre todo los valores de ejemplo del formulario.
      fallidos.push({ email: dest.email || '(vacío)', rol: dest.rol, motivo: 'Email vacío, de ejemplo o con formato inválido.' });
      continue;
    }

    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [dest.email],
          subject: `Notificación MASC Digital - Expediente ${expId} (${dest.rol})`,
          html,
        }),
      });

      let data: any = null;
      try { data = await resendRes.json(); } catch { /* respuesta sin cuerpo JSON */ }

      if (!resendRes.ok) {
        fallidos.push({ email: dest.email, rol: dest.rol, motivo: (data && data.message) || `Resend respondió ${resendRes.status}.` });
      } else {
        enviados.push(dest.email);
      }
    } catch (err) {
      fallidos.push({ email: dest.email, rol: dest.rol, motivo: 'Error inesperado al contactar con Resend: ' + (err as Error).message });
    }
  }

  return jsonResponse({ enviados, fallidos });
});
