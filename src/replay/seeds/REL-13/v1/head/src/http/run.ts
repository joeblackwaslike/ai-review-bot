export function run(job: string, timeoutMs = 5000) {
  return Promise.race([execute(job), expire(timeoutMs)]);
}
