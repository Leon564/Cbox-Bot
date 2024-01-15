import 'dotenv/config';
import Openai from 'openai';

export class Gpt {

    constructor(
        private openai = new Openai({apiKey: process.env.OPENAI_API_KEY})
    ){}

    async chat(message: string) {
        const gptResponse = await this.openai.chat.completions.create({
            messages:[
                {
                    role: 'system',
                    content:'sabes todo sobre anime'
                },
                {
                    role: 'system',
                    content:'responde con un maximo de 200 caracteres'
                },
                {
                    role: 'system',
                    content:'responde de la manera mas puntual y corta posible'
                },                
                {
                    role: 'system',
                    content:'si alguien pregunta como ver algo, cambiar el idioma de los subtitulos o accion similar, responde diciendo que no tienes acceso a informacion sobre la app de Legion Anime'
                },
                {
                    role: 'user',
                    content: message || ''
                }
            ],
            
        model: 'gpt-3.5-turbo',});

        return gptResponse.choices[0].message.content;
    }

}