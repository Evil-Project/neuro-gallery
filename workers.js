let imageList = new Array();
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0",
};

export default {
  async fetch() {
    if (imageList.length === 0) {
      try {
        const response = await fetch(
          "https://api.neurokaraoke.com/api/media/artists",
          {
            headers: HEADERS,
          },
        );
        const data = await response.json();
        const newList = new Array();
        for (const artist of data) {
          if (artist.arts) {
            for (const art of artist.arts) {
              newList.push(
                `https://images.neurokaraoke.com${art.absolutePath}/quality=95`,
              );
            }
          }
        }
        imageList = newList;
      } catch (err) {
        return new Response("Fetch Error: " + err.message, { status: 500 });
      }
    }
    if (imageList.length > 0) {
      const randomUrl = imageList[Math.floor(Math.random() * imageList.length)];
      return Response.redirect(randomUrl, 302);
    } else {
      return new Response("No images found", { status: 404 });
    }
  },
};
