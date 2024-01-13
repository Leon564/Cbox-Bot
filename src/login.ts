export const login = async (username: string, password: string) => {
  const response = await fetch(
    "https://www4.cbox.ws/box/?sec=profile&boxid=4340037&boxtag=sinvpn&_v=1063&json=1",
    {
      headers: {
        accept: "*/*",
        "accept-language": "es-419,es;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "sec-ch-ua":
          '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        Referer: "https://www4.cbox.ws/",
        "Referrer-Policy": "origin",
      },
      body: `n=${username}&k=&pword=${password}&pword2=&auth_prov=&auth_id=&do=login`,
      method: "POST",
    }
  );
  const data = await response.text();

  return JSON.parse(data.slice(1));
};

