import { load } from "cheerio";
type BoxDetailsReturn = {
    boxId: string | undefined;
    boxTag: string | undefined;
    socketUrl: string | undefined;
    iframeUrl: string | undefined;
  };

export const boxDetails = async (cbox_Url: string): Promise<BoxDetailsReturn> => {
  //if (!cbox_Url) return;
  let boxId: string | undefined = cbox_Url?.split("boxid=")[1]?.split("&")[0];
  let boxTag: string | undefined = cbox_Url?.split("boxtag=")[1];
  let socketUrl: string | undefined;
  let iframeUrl: string | undefined = cbox_Url;

  if (!cbox_Url.includes("boxid=")) {
    const response = await fetch(cbox_Url, {
      headers: {
        accept: "*/*",
        "accept-language": "es-419,es;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "sec-ch-ua":
          '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
      },
      method: "GET",
    });

    const data = await response.text();
    const $ = load(data);
    const iframe = $("iframe").attr("src")?.slice(2);
    iframeUrl = `https://${iframe}`;
    boxId = iframeUrl?.split("boxid=")[1].split("&")[0];
    boxTag = iframeUrl?.split("boxtag=")[1];
  }

  const response = await fetch(iframeUrl!, {
    headers: {
      accept: "*/*",
      "accept-language": "es-419,es;q=0.9",
      "content-type": "application/x-www-form-urlencoded",
      "sec-ch-ua":
        '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
    },
    method: "GET",
  });
  const data2 = await response.text();
  const $ = load(data2);
  const scriptContent = $("script").last().html();

  if (scriptContent) {
    // Buscar el valor de wsuri_https dentro de la función
    const wsuriHttpsMatch = scriptContent.match(/wsuri_https:"(.*?)"/);
    const wsuriHttpsValue = wsuriHttpsMatch ? wsuriHttpsMatch[1] : null;

    // Buscar el valor de flrqs dentro de la función
    const flrqsMatch = scriptContent.match(/flrqs:"(.*?)"/);
    const flrqsValue = flrqsMatch ? flrqsMatch[1] : null;

    // Imprimir los valores obtenidos
    socketUrl = `${wsuriHttpsValue}${flrqsValue}`;
  }
  return { boxId, boxTag, socketUrl, iframeUrl };
};
