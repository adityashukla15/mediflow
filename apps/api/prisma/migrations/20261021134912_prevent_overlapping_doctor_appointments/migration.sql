CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Appointment"
ADD CONSTRAINT "Appointment_no_overlapping_active_doctor_appointments"
EXCLUDE USING gist (
  "doctorId" WITH =,
  tstzrange("startAt", "endAt", '[)') WITH &&
)
WHERE (
  "status" IN (
    'SCHEDULED'::"AppointmentStatus",
    'CONFIRMED'::"AppointmentStatus"
  )
);
