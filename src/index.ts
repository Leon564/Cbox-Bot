import "dotenv/config";
import Openai from "openai";
import WebSocket from "ws";
import { login } from "./login";
import { Gpt } from "./chatGpt";
import { boxDetails } from "./boxDetails";
import { sendMessage, toDomain } from "./messages";

class Bot {
  private responseQueue: any[] = [];
  private lastSentTime: number = Date.now() - 20500;

  constructor(
    private uname: string,
    private ukey: string,
    private pic: string,
    private gpt: Gpt = new Gpt(),
    private socket: WebSocket,
    private boxId: string,
    private boxTag: string,
    private iframeUrl: string
  ) {
    setInterval(() => {
      if (
        this.responseQueue.length > 0 &&
        Date.now() - this.lastSentTime > 20500
      ) {
        const response = this.responseQueue.shift();
        sendMessage(response);
        this.lastSentTime = Date.now();
      }
    }, 1000);
  }

  public static async start() {
    const dataLogin = await login(
      process.env.CBOX_USERNAME!,
      process.env.CBOX_PASSWORD!
    );
    if (dataLogin.error) {
      console.log("error al iniciar sesion");
      console.log(dataLogin.error);
      return;
    }
    const { nme, key, pic } = dataLogin.udata;
    const { boxId, boxTag, iframeUrl, socketUrl } = await boxDetails(
      process.env.CBOX_URL!
    );
    console.log(`starting bot as ${nme}`);

    new Bot(
      nme || process.env.CBOX_USERNAME!,
      key!,
      pic || process.env.CBOX_DEFAULT_PIC!,
      new Gpt(new Openai({ apiKey: process.env.OPENAI_API_KEY! })),
      new WebSocket(socketUrl!),
      boxId!,
      boxTag!,
      iframeUrl!
    ).handleEvents();
  }

  async handleEvents() {
    this.socket.on("open", () => {
      console.log("Conexión abierta");
    });

    // Manejar los mensajes recibidos del servidor
    this.socket.on("message", async (data: WebSocket.Data) => {
      const { date, id, lvl, message, name } = toDomain(data);

      if (
        !message ||
        name === this.uname ||
        (!message.toLowerCase().includes("bot") &&
          !message.toLowerCase().includes(this.uname.toLowerCase()))
      )
        return;

      console.log(`Mensaje recibido: ${message} de ${name} el ${date}`);
      
      const response = await this.gpt.chat(message, this.uname);
      if (!response) return;
      const responseData = {
        key: this.ukey,
        message: response,
        pic: this.pic,
        username: this.uname,
        boxTag: this.boxTag,
        boxId: this.boxId,
        iframeUrl: this.iframeUrl,
      };
      if (Date.now() - this.lastSentTime < 20500) {
        this.responseQueue.push(responseData);
        return;
      }
      sendMessage(responseData);
      this.lastSentTime = Date.now();
    });
    // Manejar errores en la conexión
    this.socket.on("error", (error: Error) => {
      console.error("Error de conexión:", error.message);
      Bot.start();
    });

    // Manejar el cierre de la conexión
    this.socket.on("close", (code: number, reason: string) => {
      console.log("Conexión cerrada:", code.toString(), reason);
      Bot.start();
    });
  }
}

Bot.start();
