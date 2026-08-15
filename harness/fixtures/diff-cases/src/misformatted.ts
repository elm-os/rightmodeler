export const metadata={owner:"platform",retries:2}

export async function misformatted(prompt:string) {
 return generateText({model:"acme/large-1",prompt})
}
