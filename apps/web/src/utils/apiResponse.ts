export function apiPayload<T>(response: { data: T }): T {
  return response.data;
}
