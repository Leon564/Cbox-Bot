export const fetchSinopsis = async (name: string) => {
  const url = `https://sinopsis-finder.onrender.com/api/sinopsis?query=${name}`;
  try {
    const response = await fetch(url);

    return response?.json();
  } catch (error) {
    console.error(error);
    return null;
  }
};
