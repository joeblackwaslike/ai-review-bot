import { save, sanitize } from "./store.js";

export function createUser(input: NewUser) {
  try {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    const handle = sanitize(input.handle);
    const plan = input.plan ?? "free";
    const record = { name, email, handle, plan };
    return save(record);
  } catch (error) {
    throw new UserError("create failed", { cause: error });
  }
}

export function updateUser(id: string, input: NewUser) {
  try {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    const handle = sanitize(input.handle);
    const plan = input.plan ?? "free";
    const record = { name, email, handle, plan };
    return save(record, id);
  } catch (error) {
    return null;
  }
}
