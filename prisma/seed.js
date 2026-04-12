const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const services = [
    {
      code: 'MASAJE_RELAX',
      name: 'Masaje relajante',
      description: 'Sesion de masaje de relajacion corporal completa.',
      durationMinutes: 60,
      price: 35000
    },
    {
      code: 'LIMPIEZA_FACIAL',
      name: 'Limpieza facial profunda',
      description: 'Tratamiento facial con extraccion y mascarilla calmante.',
      durationMinutes: 75,
      price: 42000
    },
    {
      code: 'PACK_SPA',
      name: 'Circuito spa',
      description: 'Experiencia integral con jacuzzi, vapor y masaje breve.',
      durationMinutes: 90,
      price: 55000
    }
  ];

  for (const service of services) {
    await prisma.service.upsert({
      where: { code: service.code },
      update: service,
      create: service
    });
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
