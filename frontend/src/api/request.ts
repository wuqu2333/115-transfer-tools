import axios, { type AxiosResponse } from "axios";
import { createDiscreteApi } from "naive-ui";

export type RequestResult<T> = Promise<T>;

const { message } = createDiscreteApi(["message"]);

const instance = axios.create({
  baseURL: "",
  timeout: 20000,
  headers: {
    "Content-Type": "application/json",
  },
});

instance.interceptors.request.use((config) => {
  config.headers = config.headers || {};
  config.headers["Accept-Language"] = navigator.language || "zh-CN";
  return config;
});

instance.interceptors.response.use(
  (resp: AxiosResponse) => {
    const ct = resp.headers["content-type"] || "";
    const data = resp.data;
    if (ct.includes("application/json") && data && typeof data === "object" && "code" in data) {
      if ((data as any).code !== 200) {
        const msg = (data as any).message || `½Ó¿Ú´íÎó code=${(data as any).code}`;
        message.error(msg);
        return Promise.reject(new Error(msg));
      }
      return (data as any).data ?? data;
    }
    return data;
  },
  (error) => {
    const msg =
      error?.response?.data?.detail ||
      error?.response?.data?.message ||
      error?.message ||
      "ÍøÂç´íÎó";
    message.error(msg);
    return Promise.reject(error);
  },
);

export const request = instance;
