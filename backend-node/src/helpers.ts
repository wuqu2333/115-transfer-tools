export function ok(res: any, data: any = {}, message = "success") {
  return res.json({ code: 200, message, data });
}

export function fail(res: any, status = 400, message = "error", detail?: any) {
  return res.status(status).json({ code: status, message, detail });
}
