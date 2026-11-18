/** Stories rated 18+ (ageRating: 0 / 13 / 16 / 18). Clients ask for an age confirmation before opening one, and drop
 *  them from lists when the reader chose “Hide 18+” (the API keeps lists the same for everyone — CDN-cached). */
export const ADULT_AGE = 18;
export const isAdult = (story: { ageRating?: number | null }) => (story.ageRating ?? 0) >= ADULT_AGE;
