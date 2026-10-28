
export interface AppointmentEmailDetails {
  recipientName: string;
  doctorName: string;
  patientName: string;
  startAt: Date;
  endAt: Date;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return entities[character] ?? character;
  });
}

function renderEmail(
  heading: string,
  details: AppointmentEmailDetails,
  statusMessage: string,
): { subject: string; html: string; text: string } {
  const recipient = escapeHtml(details.recipientName);
  const doctor = escapeHtml(details.doctorName);
  const patient = escapeHtml(details.patientName);

  const date = details.startAt.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });

  const endDate = details.endAt.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });

  return {
    subject: `MediFlow: ${heading}`,
    text: [
      `Hello ${details.recipientName},`,
      '',
      statusMessage,
      `Patient: ${details.patientName}`,
      `Doctor: ${details.doctorName}`,
      `Start: ${date}`,
      `End: ${endDate}`,
      '',
      'Regards,',
      'MediFlow',
    ].join('\n'),
    html: `
      <!doctype html>
      <html lang="en">
        <body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6">
          <main style="max-width:560px;margin:24px auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
            <h2 style="color:#0f766e">MediFlow</h2>
            <h3>${escapeHtml(heading)}</h3>
            <p>Hello ${recipient},</p>
            <p>${escapeHtml(statusMessage)}</p>
            <ul>
              <li><strong>Patient:</strong> ${patient}</li>
              <li><strong>Doctor:</strong> ${doctor}</li>
              <li><strong>Start:</strong> ${escapeHtml(date)}</li>
              <li><strong>End:</strong> ${escapeHtml(endDate)}</li>
            </ul>
            <p>Regards,<br />MediFlow Team</p>
          </main>
        </body>
      </html>
    `,
  };
}

export function appointmentBookedTemplate(
  details: AppointmentEmailDetails,
) {
  return renderEmail(
    'Appointment booked',
    details,
    'Your appointment has been booked successfully.',
  );
}

export function appointmentCancelledTemplate(
  details: AppointmentEmailDetails,
) {
  return renderEmail(
    'Appointment cancelled',
    details,
    'This appointment has been cancelled.',
  );
}
export type AppointmentReminderKind =
  | 'TWENTY_FOUR_HOURS'
  | 'ONE_HOUR';

export function appointmentReminderTemplate(
  details: AppointmentEmailDetails,
  kind: AppointmentReminderKind,
) {
  const heading =
    kind === 'TWENTY_FOUR_HOURS'
      ? 'Appointment reminder — tomorrow'
      : 'Appointment reminder — in one hour';

  const message =
    kind === 'TWENTY_FOUR_HOURS'
      ? 'This is a reminder that your appointment is scheduled for approximately 24 hours from now.'
      : 'This is a reminder that your appointment is scheduled for approximately one hour from now.';

  return renderEmail(heading, details, message);
}