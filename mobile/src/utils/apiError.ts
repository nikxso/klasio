/**
 * Safely extracts error details from a fetch Response without throwing SyntaxError on non-JSON payloads.
 */
export async function extractErrorMessage(res: Response, fallback = 'Operation failed'): Promise<string> {
  try {
    const text = await res.text();
    if (!text || !text.trim()) {
      return `${fallback} (${res.status})`;
    }
    try {
      const data = JSON.parse(text);
      if (typeof data.detail === 'string') return data.detail;
      if (Array.isArray(data.detail) && data.detail.length > 0) {
        return data.detail.map((d: any) => d.msg || d.message || JSON.stringify(d)).join(', ');
      }
      return data.message || data.error || fallback;
    } catch {
      return text.trim().slice(0, 300) || `${fallback} (${res.status})`;
    }
  } catch {
    return `${fallback} (${res.status})`;
  }
}
