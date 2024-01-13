import "dotenv/config";
import Openai from "openai";
import WebSocket from "ws";
import { login } from "./login";
import { Gpt } from "./chatGpt";
import { boxDetails } from "./boxDetails";
import { sendMessage } from "./messages";
import { Queue } from "queue-typescript";

class Bot {
  private responseQueue: Queue<any> = new Queue<any>();
  private canSend: boolean = true;
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
      if (this.responseQueue.length > 0 && this.canSend) {
        this.canSend = false;
        const response = this.responseQueue.dequeue();
        sendMessage(response);
        setTimeout(() => {
          this.canSend = true;
        }, 20000);
      }
    }, 20000);
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
      const splitedData = data.toString().split("\t");
      if (splitedData.length <= 1) return;

      const [n, id, date, name, lvl, x, message, y, z, id2, w, id3] =
        splitedData;

      console.log(`Mensaje recibido: ${message} de ${name} el ${date}`);
      if (
        !message ||
        !message.includes("bot") ||
        message.slice(5).length < 2 ||
        name === this.uname
      )
        return;

      const response = await this.gpt.chat(message);
      if (!response) return;

      this.responseQueue.enqueue({
        key: this.ukey,
        message: response,
        pic: this.pic,
        username: this.uname,
        boxTag: this.boxTag,
        boxId: this.boxId,
        iframeUrl: this.iframeUrl,
      });
    });
    // Manejar errores en la conexión
    this.socket.on("error", (error: Error) => {
      console.error("Error de conexión:", error.message);
      Bot.start();
    });

    // Manejar el cierre de la conexión
    this.socket.on("close", (code: number, reason: string) => {
      console.log("Conexión cerrada:", code, reason);
      Bot.start();
    });
  }
}

Bot.start();
