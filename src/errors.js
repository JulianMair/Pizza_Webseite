'use strict';

// Fehler mit HTTP Status, deren Meldung dem Client angezeigt werden darf.
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.expose = true;
    if (details) this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, message, details);
const notFound = (message = 'Nicht gefunden.') => new HttpError(404, message);
const conflict = (message, details) => new HttpError(409, message, details);

module.exports = { HttpError, badRequest, notFound, conflict };
