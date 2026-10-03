import { Temporal } from '@js-temporal/polyfill';

export function createBookingEmailNotifier({ sendEmail, frontendOrigin }) {
  if (typeof sendEmail !== 'function' || !frontendOrigin) {
    throw new TypeError('An email transport and frontend origin are required');
  }
  const bookingsUrl = new URL('/reservas', frontendOrigin).toString();
  const ownerBookingsUrl = new URL('/owner/reservas', frontendOrigin).toString();

  return Object.freeze({
    confirmation: ({ email, booking }) => deliver(email, booking, 'confirmation'),
    cancellation: ({ email, booking }) => deliver(email, booking, 'cancellation'),
    ownerConfirmation: ({ email, customerName, booking }) => deliverOwner(email, customerName, booking, 'confirmation'),
    ownerCancellation: ({ email, customerName, booking }) => deliverOwner(email, customerName, booking, 'cancellation'),
    reschedule: ({ email, booking, previous }) => deliverChange(email, booking, previous,
      'Tu reserva fue modificada', 'booking-reschedule', bookingsUrl),
    ownerReschedule: ({ email, booking, previous }) => deliverChange(email, booking, previous,
      'Una reserva fue modificada', 'owner-booking-reschedule', ownerBookingsUrl),
    customerOwnerCancellation: ({ email, booking, reason }) => deliverSimple(email,
      'Tu reserva fue cancelada por el establecimiento', 'booking-owner-cancellation',
      `${booking.facility.name} · ${booking.court.name}\nMotivo: ${reason}\nPuedes priorizar una reprogramación o solicitar devolución completa cuando corresponda. No se ha procesado ninguna devolución.`, bookingsUrl),
    exceptionDecision: ({ email, booking, category, decision }) => deliverSimple(email,
      'Solicitud de excepción revisada', 'booking-exception-decision',
      `${booking.facility.name} · ${booking.court.name}\n${category === 'MAL_CLIMA' ? 'Mal clima' : 'Fuerza mayor'}: ${decision === 'APROBADA' ? 'Aprobada. Puedes elegir otro horario.' : 'Rechazada.'}`, bookingsUrl),
  });

  async function deliverSimple(email, title, type, text, url) {
    await sendEmail({ type, email, subject: `${title} - Reserva Canchas`, text: `${text}\nVer reservas: ${url}`,
      html: `<div style="font-family:Arial,sans-serif;color:#152521;max-width:520px"><h1>${escapeHtml(title)}</h1>`
        + `<p style="white-space:pre-line">${escapeHtml(text)}</p><a href="${escapeHtml(url)}">Ver reservas</a></div>` });
  }

  async function deliverChange(email, booking, previous, title, type, url) {
    const time = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: booking.timeZone });
    const price = (amount) => amount == null ? 'Precio no disponible'
      : `$${new Intl.NumberFormat('es-CO').format(amount / 100)} COP`;
    const text = `${booking.facility.name} · ${booking.court.name}\nHorario anterior: ${time.format(new Date(previous.startAt))}`
      + ` - ${time.format(new Date(previous.endAt))}\nHorario nuevo: ${time.format(new Date(booking.startAt))}`
      + ` - ${time.format(new Date(booking.endAt))}\nPrecio anterior: ${price(previous.priceMinor)}`
      + `\nPrecio nuevo: ${price(booking.priceMinor)}\nEstado: Confirmada`;
    await deliverSimple(email, title, type, text, url);
  }

  async function deliver(email, booking, kind) {
    const confirmed = kind === 'confirmation';
    const title = confirmed ? 'Reserva confirmada' : 'Reserva cancelada';
    const status = confirmed ? 'Confirmada' : 'Cancelada';
    const date = new Intl.DateTimeFormat('es-CO', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: booking.timeZone,
    }).format(new Date(booking.startAt));
    const time = new Intl.DateTimeFormat('es-CO', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: booking.timeZone,
    });
    const range = `${time.format(new Date(booking.startAt))} - ${time.format(new Date(booking.endAt))}`;
    const duration = Temporal.Instant.from(booking.startAt).until(booking.endAt).total('minutes');
    const price = booking.priceMinor == null || booking.currency == null
      ? 'Precio no disponible'
      : `$${new Intl.NumberFormat('es-CO', {
        minimumFractionDigits: booking.priceMinor % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(booking.priceMinor / 100)} ${booking.currency}`;
    const intro = confirmed ? 'Tu reserva está confirmada.' : 'Tu reserva fue cancelada.';
    const history = confirmed ? '' : 'La reserva permanecerá disponible en tu historial.';
    const lines = [intro, '', booking.facility.name, booking.court.name, '', date,
      range, `${duration} minutos`, '', price, '', `Estado: ${status}`,
      ...(history ? ['', history] : []), '', `Ver mis reservas: ${bookingsUrl}`];
    const escaped = lines.map(escapeHtml);
    await sendEmail({
      type: confirmed ? 'booking-confirmation' : 'booking-cancellation',
      email, subject: `${title} - Reserva Canchas`, text: lines.join('\n'),
      html: `<div style="font-family:Arial,sans-serif;color:#152521;max-width:520px">`
        + `<h1 style="font-size:24px;color:#0e665b">${escapeHtml(title)}</h1>`
        + `<p>${escaped[0]}</p><p><strong>${escaped[2]}</strong><br>${escaped[3]}</p>`
        + `<p>${escaped[5]}<br>${escaped[6]} · ${escaped[7]}</p>`
        + `<p><strong>${escaped[9]}</strong><br>Estado: ${escapeHtml(status)}</p>`
        + (history ? `<p>${escapeHtml(history)}</p>` : '')
        + `<p><a href="${escapeHtml(bookingsUrl)}" style="color:#0e665b">Ver mis reservas</a></p>`
        + '</div>',
    });
  }

  async function deliverOwner(email, customerName, booking, kind) {
    const confirmed = kind === 'confirmation';
    const title = confirmed ? 'Nueva reserva recibida' : 'Reserva cancelada por el cliente';
    const status = confirmed ? 'Confirmada' : 'Cancelada';
    const date = new Intl.DateTimeFormat('es-CO', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: booking.timeZone,
    }).format(new Date(booking.startAt));
    const time = new Intl.DateTimeFormat('es-CO', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: booking.timeZone,
    });
    const range = `${time.format(new Date(booking.startAt))} - ${time.format(new Date(booking.endAt))}`;
    const duration = Temporal.Instant.from(booking.startAt).until(booking.endAt).total('minutes');
    const price = booking.priceMinor == null || booking.currency == null
      ? 'Precio no disponible'
      : `$${new Intl.NumberFormat('es-CO', {
        minimumFractionDigits: booking.priceMinor % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(booking.priceMinor / 100)} ${booking.currency}`;
    const intro = confirmed ? 'Recibiste una nueva reserva' : 'Un cliente canceló una reserva.';
    const availability = confirmed ? '' : 'El horario vuelve a quedar sujeto a la disponibilidad actual de la cancha.';
    const lines = [intro, '', `Cliente: ${customerName}`, booking.facility.name, booking.court.name, '',
      date, range, `${duration} minutos`, '', price, '', `Estado: ${status}`,
      ...(availability ? ['', availability] : []), '', `Ver reservas: ${ownerBookingsUrl}`];
    const escaped = lines.map(escapeHtml);
    await sendEmail({
      type: confirmed ? 'owner-booking-confirmation' : 'owner-booking-cancellation',
      email, subject: `${title} - Reserva Canchas`, text: lines.join('\n'),
      html: `<div style="font-family:Arial,sans-serif;color:#152521;max-width:520px">`
        + `<h1 style="font-size:24px;color:#0e665b">${escapeHtml(title)}</h1>`
        + `<p>${escaped[0]}</p><p>${escaped[2]}</p><p><strong>${escaped[3]}</strong><br>${escaped[4]}</p>`
        + `<p>${escaped[6]}<br>${escaped[7]} · ${escaped[8]}</p>`
        + `<p><strong>${escaped[10]}</strong><br>Estado: ${escapeHtml(status)}</p>`
        + (availability ? `<p>${escapeHtml(availability)}</p>` : '')
        + `<p><a href="${escapeHtml(ownerBookingsUrl)}" style="color:#0e665b">Ver reservas</a></p>`
        + '</div>',
    });
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
