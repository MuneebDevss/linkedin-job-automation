import {Module} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';
import appConfig from './config/app.config';
import {DatabaseModule} from './database/database.module';
import {FormsModule} from './forms/forms.module';
import {JobsModule} from './jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({isGlobal: true, load: [appConfig]}),
    DatabaseModule,
    FormsModule,
    JobsModule
  ]
})
export class AppModule {}
