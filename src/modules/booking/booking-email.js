import { Temporal } from '@js-temporal/polyfill';

export function createBookingEmailNotifier({ sendEmail, frontendOrigin }) {
  if (typeof sendEmail !== 'function' || !frontendOrigin) {
    throw new TypeError('An email transport and frontend origin are required');
  }
  const bookingsUrl = new URL('/reservas', frontendOrigin).toString();

  return Object.freeze({
    confirmation: ({ email, booking }) => deliver(email, booking, 'confirmation'),
    cancellation: ({ email, booking }) => deliver(email, booking, 'cancellation'),
  });

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
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
