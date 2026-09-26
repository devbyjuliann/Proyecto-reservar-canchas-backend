export class UsersError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class UsersValidationError extends UsersError {
  constructor(message) {
    super('USERS_VALIDATION_ERROR', message);
  }
}

export class UserNotFoundError extends UsersError {
  constructor() {
    super('USER_NOT_FOUND', 'User not found');
  }
}

export class UsersForbiddenError extends UsersError {
  constructor() {
    super('USERS_FORBIDDEN', 'The actor cannot perform this operation');
  }
}

export class UserEmailAlreadyExistsError extends UsersError {
  constructor() {
    super('USER_EMAIL_ALREADY_EXISTS', 'A user with this email already exists');
  }
}
